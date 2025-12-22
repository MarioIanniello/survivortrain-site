/**
 * Firebase Functions (v2) – PayPal Orders API
 *
 * Exposes two HTTPS endpoints:
 *  - paypalCreateOrder  (POST) -> returns { orderID }
 *  - paypalCaptureOrder (POST) -> returns capture result
 *
 * Secrets required (set via firebase functions:secrets:set):
 *  - PAYPAL_ENV        : "sandbox" | "live"
 *  - PAYPAL_CLIENT_ID  : PayPal REST API Client ID
 *  - PAYPAL_SECRET     : PayPal REST API Secret
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

// --- Secrets (do NOT hardcode credentials) ---
const PAYPAL_ENV = defineSecret("PAYPAL_ENV");
const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");

// --- CORS ---
const ALLOWED_ORIGINS = new Set([
  "https://marioianniello.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

// --- Public site base (used for PayPal return/cancel URLs) ---
// NOTE: For GitHub Pages this is the full repository site URL.
const DEFAULT_SITE_BASE = "https://marioianniello.github.io/survivortrain-site";

function getSafeSiteBase(req, body) {
  // Priority:
  // 1) Explicit siteBase from client (must be an allowed origin or end with .github.io)
  // 2) Origin header when allowed
  // 3) Default
  const candidate = String(body?.siteBase || "").trim();
  const origin = String(req.headers.origin || "").trim();

  const isAllowed = (u) => {
    if (!u) return false;
    if (ALLOWED_ORIGINS.has(u)) return true;
    // allow any github pages origin
    return u.endsWith(".github.io");
  };

  if (candidate && isAllowed(candidate)) return candidate;
  if (origin && isAllowed(origin)) return origin;
  return DEFAULT_SITE_BASE;
}

function buildReturnCancelUrls(siteBase) {
  // Keep it simple and stable: always land back on area.html.
  const base = String(siteBase || DEFAULT_SITE_BASE).replace(/\/+$/, "");
  return {
    return_url: `${base}/area.html?paypal=success&src=paypal`,
    cancel_url: `${base}/area.html?paypal=cancel&src=paypal`,
  };
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith(".github.io"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // fallback (keeps things working during early testing)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

// --- Helpers ---
function getApiBase(env) {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function getCheckoutNowUrl(env, orderID) {
  const token = encodeURIComponent(String(orderID || "").trim());
  if (!token) return null;
  // For sandbox vs live approval redirect
  const host = env === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  return `${host}/checkoutnow?token=${token}`;
}

function asMoneyEUR(value) {
  // PayPal expects string with 2 decimals
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Importo non valido");
  return n.toFixed(2);
}

function resolvePackageAmountEUR(packageId) {
  // Package mapping: 1 vita=10€, 3 vite=20€, 5 vite=30€
  // Accepts: "1"|"3"|"5" or "pack_1"|"pack_3"|"pack_5"
  const p = String(packageId || "").trim();
  if (p === "1" || p === "pack_1") return 10;
  if (p === "3" || p === "pack_3") return 20;
  if (p === "5" || p === "pack_5") return 30;
  throw new Error("Pacchetto non valido. Usa 1, 3 oppure 5.");
}

function safeJsonParse(body) {
  // Firebase may already parse JSON, depending on content-type
  if (body && typeof body === "object") return body;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

async function paypalGetAccessToken({ env, clientId, secret }) {
  const base = getApiBase(env);
  const url = `${base}/v1/oauth2/token`;

  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    logger.error("PayPal token error", { status: resp.status, data });
    throw new Error("Errore autenticazione PayPal");
  }

  if (!data.access_token) throw new Error("Token PayPal mancante");
  return data.access_token;
}

async function paypalCreateOrderApi({ env, accessToken, amountEUR, teamName, packageId, siteBase }) {
  const base = getApiBase(env);
  const url = `${base}/v2/checkout/orders`;

  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "EUR",
          value: amountEUR,
        },
        description: `Skillboll Survivor Train – Pacchetto ${packageId} vite – ${teamName}`,
      },
    ],
    application_context: {
      // If you want a pure redirect-based approval flow (useful for CLI testing),
      // PayPal expects return_url and cancel_url.
      ...buildReturnCancelUrls(siteBase),
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    logger.error("PayPal create order error", { status: resp.status, data });
    throw new Error("Errore creazione ordine PayPal");
  }

  if (!data.id) throw new Error("Order ID PayPal mancante");
  return data;
}

async function paypalCaptureOrderApi({ env, accessToken, orderID }) {
  const base = getApiBase(env);
  const url = `${base}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    logger.error("PayPal capture error", { status: resp.status, data });
    const msg = data?.message || data?.name || "Errore cattura pagamento PayPal";
    const details = Array.isArray(data?.details) ? data.details : null;
    const err = new Error(msg);
    err.paypal = { status: resp.status, details, debug_id: data?.debug_id };
    throw err;
  }

  return data;
}

// --- Functions ---
exports.paypalCreateOrder = onRequest(
  {
    secrets: [PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_SECRET],
    region: "europe-west1",
  },
  async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    try {
      const body = safeJsonParse(req.body);
      const teamName = String(body.teamName || "").trim();
      const packageId = String(body.packageId || "").trim();
      const siteBase = getSafeSiteBase(req, body);

      if (!teamName) {
        res.status(400).json({ error: "teamName obbligatorio" });
        return;
      }
      if (teamName.length > 40) {
        res.status(400).json({ error: "teamName troppo lungo (max 40 caratteri)" });
        return;
      }
      if (!packageId) {
        res.status(400).json({ error: "packageId obbligatorio (1, 3 oppure 5)" });
        return;
      }

      const amount = resolvePackageAmountEUR(packageId);
      const amountEUR = asMoneyEUR(amount);

      const env = String(PAYPAL_ENV.value() || "sandbox").trim().toLowerCase();
      const clientId = String(PAYPAL_CLIENT_ID.value() || "");
      const secret = String(PAYPAL_SECRET.value() || "");

      if (!clientId || !secret) {
        res.status(500).json({ error: "Config PayPal mancante" });
        return;
      }

      const accessToken = await paypalGetAccessToken({ env, clientId, secret });
      const order = await paypalCreateOrderApi({
        env,
        accessToken,
        amountEUR,
        teamName,
        packageId,
        siteBase,
      });

      const approveLink = Array.isArray(order.links)
        ? order.links.find((l) => l && l.rel === "approve")
        : null;

      const approveUrl = approveLink?.href || getCheckoutNowUrl(env, order.id);

      // Return the approval URL so the client can redirect the user directly to PayPal.
      res.status(200).json({
        orderID: order.id,
        approveUrl,
        env,
        links: Array.isArray(order.links)
          ? order.links
              .filter((l) => l && l.rel && l.href)
              .map((l) => ({ rel: l.rel, href: l.href }))
          : [],
      });
    } catch (err) {
      logger.error("paypalCreateOrder error", err);
      res.status(500).json({ error: err?.message || "Errore server" });
    }
  }
);

exports.paypalCaptureOrder = onRequest(
  {
    secrets: [PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_SECRET],
    region: "europe-west1",
  },
  async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    try {
      const body = safeJsonParse(req.body);
      const orderID = String(body.orderID || "").trim();

      if (!orderID) {
        res.status(400).json({ error: "orderID obbligatorio" });
        return;
      }

      const env = String(PAYPAL_ENV.value() || "sandbox").trim().toLowerCase();
      const clientId = String(PAYPAL_CLIENT_ID.value() || "");
      const secret = String(PAYPAL_SECRET.value() || "");

      if (!clientId || !secret) {
        res.status(500).json({ error: "Config PayPal mancante" });
        return;
      }

      const accessToken = await paypalGetAccessToken({ env, clientId, secret });
      const capture = await paypalCaptureOrderApi({ env, accessToken, orderID });

      const status = String(capture?.status || "").toUpperCase();
      if (status && status !== "COMPLETED") {
        res.status(400).json({ error: `Pagamento non completato (${status})`, capture });
        return;
      }

      res.status(200).json({ capture });
    } catch (err) {
      logger.error("paypalCaptureOrder error", err);
      res.status(500).json({
        error: err?.message || "Errore server",
        paypal: err?.paypal || null,
      });
    }
  }
);
