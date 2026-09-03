const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

/* ==================== uploads ==================== */
const PASTA_UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(PASTA_UPLOADS)) fs.mkdirSync(PASTA_UPLOADS);
app.use("/uploads", express.static(PASTA_UPLOADS));

const upload = multer({
  storage: multer.diskStorage({
    destination: PASTA_UPLOADS,
    filename: (req, arquivo, cb) => {
      const sufixo = crypto.randomBytes(8).toString("hex");
      cb(null, sufixo + path.extname(arquivo.originalname));
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

function gerarCodigo(tamanho) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < tamanho; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  return codigo;
}

/* ==================== auth simples do painel ====================
   MVP: uma senha única definida em variável de ambiente. Antes de usar
   com dados reais, troque por login de usuário de verdade. */
function exigirSenhaAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PASSWORD || senha !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ erro: "senha inválida" });
  }
  next();
}

/* ==================== auth do player (token da tela) ==================== */
async function exigirTokenTela(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "token ausente" });

  const { rows } = await pool.query("SELECT * FROM telas WHERE token = $1", [token]);
  if (rows.length === 0) return res.status(401).json({ erro: "token inválido" });

  req.tela = rows[0];
  next();
}

/* ==================== endpoints do player ==================== */

// Player envia o código mostrado na tela; se existir e ainda não tiver dono, gera o token
app.post("/telas/parear", async (req, res) => {
  const { codigo } = req.body;
  const { rows } = await pool.query(
    "SELECT * FROM telas WHERE codigo_pareamento = $1", [codigo]
  );
  if (rows.length === 0) return res.status(404).json({ erro: "código não encontrado" });

  const token = crypto.randomBytes(24).toString("hex");
  await pool.query(
    "UPDATE telas SET token = $1, codigo_pareamento = NULL WHERE id = $2",
    [token, rows[0].id]
  );
  res.json({ token });
});

app.get("/telas/playlist", exigirTokenTela, async (req, res) => {
  if (!req.tela.playlist_id_atual) return res.json({ itens: [] });

  const { rows } = await pool.query(
    `SELECT m.tipo, m.url, COALESCE(pi.duracao, m.duracao_padrao) AS duracao
     FROM playlist_itens pi
     JOIN midias m ON m.id = pi.midia_id
     WHERE pi.playlist_id = $1
     ORDER BY pi.ordem`,
    [req.tela.playlist_id_atual]
  );
  res.json({ itens: rows });
});

app.post("/telas/heartbeat", exigirTokenTela, async (req, res) => {
  await pool.query(
    "UPDATE telas SET status = 'online', ultimo_heartbeat = now() WHERE id = $1",
    [req.tela.id]
  );
  res.json({ ok: true });
});

/* ==================== endpoints do painel (telas) ==================== */

app.get("/api/telas", exigirSenhaAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.nome, t.status, t.codigo_pareamento, t.playlist_id_atual,
            l.nome AS loja
     FROM telas t JOIN lojas l ON l.id = t.loja_id
     ORDER BY t.id DESC`
  );
  res.json(rows);
});

app.post("/api/telas", exigirSenhaAdmin, async (req, res) => {
  const { nome, lojaId } = req.body;
  const codigo = gerarCodigo(6);
  const { rows } = await pool.query(
    "INSERT INTO telas (loja_id, nome, codigo_pareamento) VALUES ($1, $2, $3) RETURNING *",
    [lojaId, nome, codigo]
  );
  res.json(rows[0]);
});

app.patch("/api/telas/:id/playlist", exigirSenhaAdmin, async (req, res) => {
  const { playlistId } = req.body;
  await pool.query("UPDATE telas SET playlist_id_atual = $1 WHERE id = $2", [playlistId || null, req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/telas/:id", exigirSenhaAdmin, async (req, res) => {
  await pool.query("DELETE FROM telas WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/lojas", exigirSenhaAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM lojas ORDER BY nome");
  res.json(rows);
});

/* ==================== endpoints do painel (mídia) ==================== */

app.get("/api/midias", exigirSenhaAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM midias ORDER BY id DESC");
  res.json(rows);
});

app.post("/api/midias", exigirSenhaAdmin, upload.single("arquivo"), async (req, res) => {
  const tipo = req.file.mimetype.startsWith("video") ? "video" : "imagem";
  const url = `/uploads/${req.file.filename}`;
  const nome = req.body.nome || req.file.originalname;
  const duracao = parseInt(req.body.duracaoPadrao, 10) || 10;

  const { rows } = await pool.query(
    "INSERT INTO midias (nome, tipo, url, duracao_padrao) VALUES ($1, $2, $3, $4) RETURNING *",
    [nome, tipo, url, duracao]
  );
  res.json(rows[0]);
});

app.delete("/api/midias/:id", exigirSenhaAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT url FROM midias WHERE id = $1", [req.params.id]);
  await pool.query("DELETE FROM midias WHERE id = $1", [req.params.id]);
  if (rows[0]) {
    const caminho = path.join(__dirname, rows[0].url);
    fs.unlink(caminho, () => {}); // ignora erro se já não existir
  }
  res.json({ ok: true });
});

/* ==================== endpoints do painel (playlists) ==================== */

app.get("/api/playlists", exigirSenhaAdmin, async (req, res) => {
  const { rows: playlists } = await pool.query("SELECT * FROM playlists ORDER BY id DESC");
  for (const p of playlists) {
    const { rows: itens } = await pool.query(
      `SELECT pi.id, pi.ordem, pi.duracao, m.id AS midia_id, m.nome, m.tipo, m.url
       FROM playlist_itens pi JOIN midias m ON m.id = pi.midia_id
       WHERE pi.playlist_id = $1 ORDER BY pi.ordem`,
      [p.id]
    );
    p.itens = itens;
  }
  res.json(playlists);
});

app.post("/api/playlists", exigirSenhaAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "INSERT INTO playlists (nome) VALUES ($1) RETURNING *", [req.body.nome]
  );
  res.json(rows[0]);
});

app.delete("/api/playlists/:id", exigirSenhaAdmin, async (req, res) => {
  await pool.query("DELETE FROM playlists WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/playlists/:id/itens", exigirSenhaAdmin, async (req, res) => {
  const { midiaId, duracao } = req.body;
  const { rows: existentes } = await pool.query(
    "SELECT COALESCE(MAX(ordem), -1) AS max FROM playlist_itens WHERE playlist_id = $1",
    [req.params.id]
  );
  const proximaOrdem = existentes[0].max + 1;

  const { rows } = await pool.query(
    "INSERT INTO playlist_itens (playlist_id, midia_id, ordem, duracao) VALUES ($1, $2, $3, $4) RETURNING *",
    [req.params.id, midiaId, proximaOrdem, duracao || null]
  );
  res.json(rows[0]);
});

app.delete("/api/playlists/:id/itens/:itemId", exigirSenhaAdmin, async (req, res) => {
  await pool.query("DELETE FROM playlist_itens WHERE id = $1", [req.params.itemId]);
  res.json({ ok: true });
});

app.patch("/api/playlists/:id/itens/reordenar", exigirSenhaAdmin, async (req, res) => {
  const { ordemDeIds } = req.body; // array de ids de playlist_itens na nova ordem
  for (let i = 0; i < ordemDeIds.length; i++) {
    await pool.query("UPDATE playlist_itens SET ordem = $1 WHERE id = $2", [i, ordemDeIds[i]]);
  }
  res.json({ ok: true });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`API rodando na porta ${PORTA}`));
