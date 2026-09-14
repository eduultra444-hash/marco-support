require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const express = require("express");
const axios = require("axios");
const QRCode = require("qrcode");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require("discord.js");

const REQUIRED = [
  "BOT_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "BASE_URL",
  "CHECKOUT_SECRET",
  "INTER_CLIENT_ID",
  "INTER_CLIENT_SECRET",
  "INTER_CERT_BASE64",
  "INTER_KEY_BASE64",
  "INTER_PIX_KEY"
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌ Falta configurar ${key}.`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL.replace(/\/+$/, "");
const PRODUCT_NAME = process.env.PRODUCT_NAME || "Produto Digital";
const PRODUCT_PRICE = Number(process.env.PRODUCT_PRICE || 5);

const INTER_BASE_URL =
  process.env.INTER_ENV === "sandbox"
    ? "https://cdpj-sandbox.partners.uatinter.co"
    : "https://cdpj.partners.bancointer.com.br";

const cert = Buffer.from(process.env.INTER_CERT_BASE64, "base64");
const key = Buffer.from(process.env.INTER_KEY_BASE64, "base64");

const httpsAgent = new https.Agent({
  cert,
  key,
  rejectUnauthorized: true
});

const interApi = axios.create({
  baseURL: INTER_BASE_URL,
  httpsAgent,
  timeout: 20000
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const ordersPath = path.join(__dirname, "orders.json");
const deliveriesPath = path.join(__dirname, "deliveries.json");

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function saveOrder(txid, order) {
  const data = readJson(ordersPath, {});
  data[txid] = order;
  writeJson(ordersPath, data);
}

function getOrder(txid) {
  return readJson(ordersPath, {})[txid] || null;
}

function isDelivered(txid) {
  return Boolean(readJson(deliveriesPath, {})[txid]);
}

function markDelivered(txid) {
  const data = readJson(deliveriesPath, {});
  data[txid] = { deliveredAt: new Date().toISOString() };
  writeJson(deliveriesPath, data);
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, content) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main class="wrap"><section class="card">${content}</section></main>
</body>
</html>`;
}

function signCheckout(discordUserId) {
  const payload = {
    uid: String(discordUserId),
    exp: Date.now() + 30 * 60 * 1000,
    nonce: crypto.randomUUID()
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const sig = crypto
    .createHmac("sha256", process.env.CHECKOUT_SECRET)
    .update(body)
    .digest("base64url");

  return `${body}.${sig}`;
}

function verifyCheckout(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;

    const expected = crypto
      .createHmac("sha256", process.env.CHECKOUT_SECRET)
      .update(body)
      .digest("base64url");

    const a = Buffer.from(sig);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    );

    if (!payload.uid || Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

let cachedToken = null;
let cachedTokenUntil = 0;

async function getInterToken() {
  if (cachedToken && Date.now() < cachedTokenUntil) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    client_id: process.env.INTER_CLIENT_ID,
    client_secret: process.env.INTER_CLIENT_SECRET,
    scope: "pix.read pix.write",
    grant_type: "client_credentials"
  });

  const response = await interApi.post(
    "/oauth/v2/token",
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  cachedToken = response.data.access_token;
  const expiresIn = Number(response.data.expires_in || 3600);
  cachedTokenUntil = Date.now() + Math.max(60, expiresIn - 60) * 1000;

  return cachedToken;
}

function makeTxid() {
  return crypto.randomBytes(16).toString("hex"); // 32 chars
}

async function createInterPix({ txid, name, cpf }) {
  const token = await getInterToken();

  const response = await interApi.put(
    `/pix/v2/cob/${txid}`,
    {
      calendario: {
        expiracao: 900
      },
      devedor: {
        cpf: String(cpf),
        nome: String(name).trim()
      },
      valor: {
        original: PRODUCT_PRICE.toFixed(2)
      },
      chave: process.env.INTER_PIX_KEY,
      solicitacaoPagador: `Compra ${PRODUCT_NAME}`
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
}

async function getInterPix(txid) {
  const token = await getInterToken();

  const response = await interApi.get(
    `/pix/v2/cob/${encodeURIComponent(txid)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  return response.data;
}

function isPaid(charge) {
  if (charge?.status !== "CONCLUIDA") return false;

  const paidValue =
    Array.isArray(charge.pix) && charge.pix.length
      ? Number(charge.pix.reduce((sum, p) => sum + Number(p.valor || 0), 0))
      : 0;

  return paidValue >= PRODUCT_PRICE;
}

async function deliverProduct(txid, charge) {
  if (!isPaid(charge)) return false;
  if (isDelivered(txid)) return true;

  const order = getOrder(txid);
  if (!order?.discordUserId) return false;

  const productPath = path.join(__dirname, "produto.txt");
  if (!fs.existsSync(productPath)) {
    throw new Error("produto.txt não encontrado.");
  }

  const product = fs.readFileSync(productPath, "utf8");
  const user = await client.users.fetch(order.discordUserId);

  await user.send(
    `✅ **Pagamento confirmado!**\n\n` +
    `Obrigado pela compra de **${PRODUCT_NAME}**.\n` +
    `Valor: **R$ ${PRODUCT_PRICE.toFixed(2).replace(".", ",")}**\n\n` +
    `📦 **Seu produto:**\n\n` +
    "```text\n" +
    product.slice(0, 1800) +
    "\n```"
  );

  markDelivered(txid);
  console.log(`✅ Produto entregue: ${txid}`);
  return true;
}

const commands = [
  new SlashCommandBuilder()
    .setName("painelcompras")
    .setDescription("Envia o painel de compras")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON()
];

client.once("ready", async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("✅ /painelcompras registrado.");
  } catch (error) {
    console.error("❌ Erro ao registrar comando:", error);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "painelcompras"
    ) {
      const embed = new EmbedBuilder()
        .setColor(0xFF7A00)
        .setTitle(`🛒 ${PRODUCT_NAME}`)
        .setDescription(
          "Compra automática via **Pix Banco Inter**.\n\n" +
          "Após o pagamento ser confirmado, o produto é enviado automaticamente no privado."
        )
        .addFields({
          name: "💰 Valor",
          value: `R$ ${PRODUCT_PRICE.toFixed(2).replace(".", ",")}`,
          inline: true
        })
        .setFooter({
          text: "Cobrança Pix • Banco Inter"
        });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("comprar_produto")
          .setLabel("Comprar")
          .setEmoji("🛒")
          .setStyle(ButtonStyle.Success)
      );

      await interaction.reply({
        embeds: [embed],
        components: [row]
      });

      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId === "comprar_produto"
    ) {
      const token = signCheckout(interaction.user.id);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(
            `Finalizar • R$ ${PRODUCT_PRICE.toFixed(2).replace(".", ",")}`
          )
          .setEmoji("💳")
          .setStyle(ButtonStyle.Link)
          .setURL(
            `${BASE_URL}/checkout?token=${encodeURIComponent(token)}`
          )
      );

      await interaction.reply({
        content: "Abra o checkout Pix abaixo. O link expira em 30 minutos.",
        components: [row],
        ephemeral: true
      });
    }
  } catch (error) {
    console.error("❌ Discord:", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "❌ Ocorreu um erro.",
          ephemeral: true
        })
        .catch(() => {});
    }
  }
});

app.get("/", (req, res) => {
  res.send(
    page(
      "Marco Store",
      `
      <div class="brand">
        <div class="brand-icon">🟠</div>
        <h1>Marco Store</h1>
        <p class="muted">Inicie sua compra pelo Discord.</p>
      </div>
      `
    )
  );
});

app.get("/checkout", (req, res) => {
  const token = String(req.query.token || "");

  if (!verifyCheckout(token)) {
    return res.status(400).send(
      page(
        "Link inválido",
        `<h1>Link inválido ou expirado</h1>`
      )
    );
  }

  res.send(
    page(
      "Finalizar compra",
      `
      <div class="brand">
        <div class="brand-icon">🟠</div>
        <h1>Finalizar compra</h1>
        <p class="muted">${escapeHtml(PRODUCT_NAME)}</p>
      </div>

      <div class="price">
        R$ ${PRODUCT_PRICE.toFixed(2).replace(".", ",")}
      </div>

      <div class="pix">
        <b>✓ Pix Banco Inter</b>
        <p class="muted">
          Depois do pagamento, a confirmação é automática.
        </p>
      </div>

      <form method="post" action="/criar-pix">
        <input type="hidden" name="token" value="${escapeHtml(token)}">

        <label>Nome completo</label>
        <input name="name" required maxlength="100">

        <label>CPF — somente números</label>
        <input
          name="cpf"
          inputmode="numeric"
          pattern="[0-9]{11}"
          maxlength="11"
          required
        >

        <button type="submit">
          Gerar QR Code Pix
        </button>
      </form>

      <p class="note">
        A cobrança é criada pela API Pix do Banco Inter.
      </p>
      `
    )
  );
});

app.post("/criar-pix", async (req, res) => {
  try {
    const { token, name, cpf } = req.body;
    const checkout = verifyCheckout(token);

    if (!checkout) {
      return res.status(400).send(
        page("Erro", "<h1>Link inválido ou expirado</h1>")
      );
    }

    if (!/^[0-9]{11}$/.test(String(cpf || ""))) {
      return res.status(400).send(
        page("Erro", "<h1>CPF inválido</h1>")
      );
    }

    const txid = makeTxid();

    saveOrder(txid, {
      discordUserId: checkout.uid,
      createdAt: new Date().toISOString(),
      amount: PRODUCT_PRICE
    });

    const charge = await createInterPix({
      txid,
      name,
      cpf
    });

    const pixCopiaECola = charge.pixCopiaECola;

    if (!pixCopiaECola) {
      throw new Error("Inter não retornou pixCopiaECola.");
    }

    const qrDataUrl = await QRCode.toDataURL(pixCopiaECola, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360
    });

    res.send(
      page(
        "Pague com Pix",
        `
        <div class="brand">
          <div class="brand-icon">⚡</div>
          <h1>Pague com Pix</h1>
          <p class="muted">Escaneie o QR Code no seu aplicativo bancário.</p>
        </div>

        <div class="price">
          R$ ${PRODUCT_PRICE.toFixed(2).replace(".", ",")}
        </div>

        <img
          class="qr"
          src="${qrDataUrl}"
          alt="QR Code Pix"
        >

        <label>Pix Copia e Cola</label>

        <div class="copy" id="pix-code">${escapeHtml(pixCopiaECola)}</div>

        <button
          type="button"
          onclick="
            navigator.clipboard.writeText(
              document.getElementById('pix-code').innerText
            );
            this.innerText='Pix copiado!';
          "
        >
          Copiar Pix
        </button>

        <div id="status" class="wait">
          ⏳ Aguardando pagamento...
        </div>

        <script>
          const txid = ${JSON.stringify(txid)};

          async function checkPayment() {
            try {
              const response = await fetch(
                '/status/' + encodeURIComponent(txid)
              );

              const result = await response.json();

              if (result.status === 'CONCLUIDA') {
                const el = document.getElementById('status');
                el.className = 'ok';
                el.innerText =
                  '✅ Pagamento confirmado! Confira sua DM no Discord.';
                return;
              }
            } catch (error) {}

            setTimeout(checkPayment, 4000);
          }

          setTimeout(checkPayment, 4000);
        </script>
        `
      )
    );
  } catch (error) {
    console.error(
      "❌ Erro criando Pix Inter:",
      error.response?.data || error
    );

    res.status(500).send(
      page(
        "Erro",
        `
        <h1>Não foi possível gerar o Pix</h1>
        <div class="wait">
          Confira as credenciais, certificado e permissões da API Pix do Inter.
        </div>
        `
      )
    );
  }
});

app.get("/status/:txid", async (req, res) => {
  try {
    const txid = String(req.params.txid);

    if (!getOrder(txid)) {
      return res.status(404).json({
        error: "order_not_found"
      });
    }

    const charge = await getInterPix(txid);

    if (isPaid(charge)) {
      await deliverProduct(txid, charge).catch(error => {
        console.error("❌ Entrega:", error);
      });
    }

    res.json({
      status: charge.status
    });
  } catch (error) {
    console.error(
      "❌ Consulta Inter:",
      error.response?.data || error
    );

    res.status(500).json({
      error: "status_error"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Site online na porta ${PORT}`);
  console.log("🏦 Integração: Banco Inter API Pix");
});

client.login(process.env.BOT_TOKEN);
