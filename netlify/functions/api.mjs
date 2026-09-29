import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (s, max = 40) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  return Boolean(key) && req.headers.get("x-admin-key") === key;
}

async function tally(store, game) {
  const { blobs } = await store.list({ prefix: `votes/${game.id}/` });
  const votes = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
  const counts = new Map(game.players.map((p) => [p, 0]));
  for (const v of votes) if (counts.has(v.candidate)) counts.set(v.candidate, counts.get(v.candidate) + 1);
  const results = [...counts].map(([name, votes]) => ({ name, votes })).sort((a, b) => b.votes - a.votes);
  return { results, voted: votes.map((v) => v.voter), total: votes.length };
}

export default async (req) => {
  const store = getStore({ name: "mvp-vote", consistency: "strong" });
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  try {
    if (parts[0] === "check") return isAdmin(req) ? json({ ok: true }) : json({ error: "הקוד שגוי" }, 401);
    if (parts[0] !== "games") return json({ error: "לא נמצא" }, 404);

    const [, id, action] = parts;

    // --- רשימת משחקים / יצירת משחק (מנהל בלבד)
    if (!id) {
      if (!isAdmin(req)) return json({ error: "נדרש קוד מנהל" }, 401);
      if (method === "GET") {
        const { blobs } = await store.list({ prefix: "games/" });
        const games = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))))
          .filter(Boolean)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 30)
          .map(({ id, title, createdAt, closed, players }) => ({ id, title, createdAt, closed, count: players.length }));
        return json({ games });
      }
      if (method === "POST") {
        const body = await req.json().catch(() => ({}));
        const players = [...new Set((body.players || []).map((p) => clean(p)).filter(Boolean))];
        if (players.length < 2) return json({ error: "צריך לבחור לפחות שני שחקנים" }, 400);
        if (players.length > 40) return json({ error: "אפשר עד 40 שחקנים" }, 400);
        const game = { id: newId(), title: clean(body.title, 60) || "משחק", players, closed: false, createdAt: Date.now() };
        await store.setJSON(`games/${game.id}`, game);
        return json(game, 201);
      }
      return json({ error: "פעולה לא נתמכת" }, 405);
    }

    if (!/^[a-f0-9]{10}$/.test(id)) return json({ error: "ההצבעה לא נמצאה" }, 404);
    const game = await store.get(`games/${id}`, { type: "json" });
    if (!game) return json({ error: "ההצבעה לא נמצאה" }, 404);

    // --- צפייה ציבורית
    if (!action && method === "GET") {
      const pub = { id: game.id, title: game.title, players: game.players, closed: game.closed };
      if (game.closed) pub.results = (await tally(store, game)).results;
      return json(pub);
    }

    // --- הצבעה
    if (action === "vote" && method === "POST") {
      if (game.closed) return json({ error: "ההצבעה כבר נסגרה" }, 409);
      const body = await req.json().catch(() => ({}));
      const voter = clean(body.voter);
      const candidate = clean(body.candidate);
      const vi = game.players.indexOf(voter);
      if (vi < 0 || !game.players.includes(candidate)) return json({ error: "שחקן לא מוכר" }, 400);
      if (voter === candidate) return json({ error: "אי אפשר להצביע לעצמך" }, 400);
      await store.setJSON(`votes/${id}/${vi}`, { voter, candidate, at: Date.now() });
      return json({ ok: true });
    }

    // --- מכאן: מנהל בלבד
    if (!isAdmin(req)) return json({ error: "נדרש קוד מנהל" }, 401);

    if (action === "results" && method === "GET") {
      return json({ id: game.id, title: game.title, players: game.players, closed: game.closed, ...(await tally(store, game)) });
    }
    if (action === "status" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      game.closed = Boolean(body.closed);
      await store.setJSON(`games/${id}`, game);
      return json({ ok: true, closed: game.closed });
    }
    if (!action && method === "DELETE") {
      const { blobs } = await store.list({ prefix: `votes/${id}/` });
      await Promise.all(blobs.map((b) => store.delete(b.key)));
      await store.delete(`games/${id}`);
      return json({ ok: true });
    }
    return json({ error: "פעולה לא נתמכת" }, 405);
  } catch (err) {
    console.error(err);
    return json({ error: "שגיאת שרת. נסו שוב בעוד רגע." }, 500);
  }
};
