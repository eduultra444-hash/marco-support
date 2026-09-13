require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

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

// =====================================
// CONFIGURAÇÃO
// =====================================

const REQUIRED = [
  "BOT_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "BASE_URL",
  "CHECKOUT_SECRET",
  "PICPAY_CLIENT_ID",
  "PICPAY_CLIENT_SECRET",
  "PICPAY_WEBHOOK_TOKEN"
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌ Falta configurar ${key}.`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL.replace(/\/+$/, "");

const PRODUCT_NAME =
  process.env.PRODUCT_NAME ||
  "Produto Digital";

const PRODUCT_PRICE =
  Number(process.env.PRODUCT_PRICE || 5);

const PRODUCT_PRICE_CENTS =
  Math.round(PRODUCT_PRICE * 100);

const PICPAY_BASE_URL =
  process.env.PICPAY_ENV === "sandbox"
    ? "https://ecommerce-api.svcp.ppay.me"
    : "https://ecommerce-api.svcp.picpay.com";

const app = express();

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// =====================================
// ARQUIVOS
// =====================================

const ordersPath =
  path.join(
    __dirname,
    "orders.json"
  );

const deliveriesPath =
  path.join(
    __dirname,
    "deliveries.json"
  );

function readJsonFile(
  file,
  fallback = {}
) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );

  } catch {
    return fallback;
  }
}

function writeJsonFile(
  file,
  data
) {
  fs.writeFileSync(
    file,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );
}

function saveOrder(
  merchantChargeId,
  data
) {
  const orders =
    readJsonFile(
      ordersPath,
      {}
    );

  orders[merchantChargeId] =
    data;

  writeJsonFile(
    ordersPath,
    orders
  );
}

function getOrder(
  merchantChargeId
) {
  const orders =
    readJsonFile(
      ordersPath,
      {}
    );

  return orders[
    merchantChargeId
  ] || null;
}

function alreadyDelivered(
  merchantChargeId
) {
  const deliveries =
    readJsonFile(
      deliveriesPath,
      {}
    );

  return Boolean(
    deliveries[
      merchantChargeId
    ]
  );
}

function markDelivered(
  merchantChargeId
) {
  const deliveries =
    readJsonFile(
      deliveriesPath,
      {}
    );

  deliveries[
    merchantChargeId
  ] = {
    deliveredAt:
      new Date()
        .toISOString()
  };

  writeJsonFile(
    deliveriesPath,
    deliveries
  );
}

// =====================================
// TOKEN CHECKOUT
// =====================================

function base64url(
  value
) {
  return Buffer
    .from(value)
    .toString(
      "base64url"
    );
}

function createCheckoutToken(
  discordUserId
) {
  const payload = {

    uid:
      String(
        discordUserId
      ),

    exp:
      Date.now() +
      30 * 60 * 1000,

    nonce:
      crypto
        .randomUUID()
  };

  const body =
    base64url(
      JSON.stringify(
        payload
      )
    );

  const signature =
    crypto
      .createHmac(
        "sha256",
        process.env
          .CHECKOUT_SECRET
      )
      .update(body)
      .digest(
        "base64url"
      );

  return (
    `${body}.${signature}`
  );
}

function verifyCheckoutToken(
  token
) {
  try {

    const [
      body,
      signature
    ] =
      String(
        token || ""
      ).split(".");

    if (
      !body ||
      !signature
    ) {
      return null;
    }

    const expected =
      crypto
        .createHmac(
          "sha256",
          process.env
            .CHECKOUT_SECRET
        )
        .update(body)
        .digest(
          "base64url"
        );

    const a =
      Buffer.from(
        signature
      );

    const b =
      Buffer.from(
        expected
      );

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(
        a,
        b
      )
    ) {
      return null;
    }

    const payload =
      JSON.parse(
        Buffer
          .from(
            body,
            "base64url"
          )
          .toString(
            "utf8"
          )
      );

    if (
      !payload.uid ||
      Date.now() >
        payload.exp
    ) {
      return null;
    }

    return payload;

  } catch {
    return null;
  }
}

// =====================================
// HTML
// =====================================

function escapeHtml(
  value
) {
  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

function page(
  title,
  content
) {
  return `
<!doctype html>

<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${escapeHtml(title)}
</title>

<link
  rel="stylesheet"
  href="/style.css"
>

</head>

<body>

<main class="wrap">

<section class="card">

${content}

</section>

</main>

</body>

</html>
`;
}

// =====================================
// PICPAY TOKEN
// =====================================

let cachedPicPayToken = null;

let cachedPicPayTokenExpiresAt = 0;

async function getPicPayToken() {

  if (
    cachedPicPayToken &&
    Date.now() <
      cachedPicPayTokenExpiresAt
  ) {
    return cachedPicPayToken;
  }

  const response =
    await axios.post(

      `${PICPAY_BASE_URL}/oauth2/token`,

      {
        grant_type:
          "client_credentials",

        client_id:
          process.env
            .PICPAY_CLIENT_ID,

        client_secret:
          process.env
            .PICPAY_CLIENT_SECRET
      },

      {
        headers: {

          accept:
            "application/json",

          "Content-Type":
            "application/json"
        }
      }
    );

  cachedPicPayToken =
    response.data
      .access_token;

  const expiresIn =
    Number(
      response.data
        .expires_in || 300
    );

  cachedPicPayTokenExpiresAt =
    Date.now() +
    Math.max(
      30,
      expiresIn - 20
    ) * 1000;

  return cachedPicPayToken;
}

// =====================================
// CRIAR PIX
// =====================================

async function createPicPayPix({
  merchantChargeId,
  customerName,
  customerEmail,
  cpf,
  ip
}) {

  const accessToken =
    await getPicPayToken();

  const body = {

    paymentSource:
      "GATEWAY",

    merchantChargeId,

    customer: {

      name:
        customerName,

      email:
        customerEmail,

      documentType:
        "CPF",

      document:
        cpf
    },

    transactions: [
      {
        amount:
          PRODUCT_PRICE_CENTS,

        pix: {
          expiration:
            900
        }
      }
    ],

    deviceInformation: {
      ip:
        ip || "127.0.0.1"
    }
  };

  const response =
    await axios.post(

      `${PICPAY_BASE_URL}/charge/pix`,

      body,

      {
        headers: {

          Authorization:
            `Bearer ${accessToken}`,

          accept:
            "application/json",

          "Content-Type":
            "application/json",

          "caller-origin":
            "marco-store-discord"
        }
      }
    );

  return response.data;
}

// =====================================
// CONSULTAR PIX
// =====================================

async function getPicPayCharge(
  merchantChargeId
) {

  const accessToken =
    await getPicPayToken();

  const response =
    await axios.get(

      `${PICPAY_BASE_URL}/charge/${encodeURIComponent(merchantChargeId)}`,

      {
        headers: {

          Authorization:
            `Bearer ${accessToken}`,

          accept:
            "application/json",

          "caller-origin":
            "marco-store-discord"
        }
      }
    );

  return response.data;
}

// =====================================
// VERIFICAR PAGAMENTO
// =====================================

function isChargePaid(
  charge
) {

  if (
    charge?.chargeStatus !==
    "PAID"
  ) {
    return false;
  }

  if (
    Number(
      charge.amount
    ) !==
    PRODUCT_PRICE_CENTS
  ) {
    return false;
  }

  const pixTransaction =
    Array.isArray(
      charge.transactions
    )
      ? charge.transactions.find(
          transaction =>
            transaction.paymentType ===
              "PIX" &&
            transaction.transactionStatus ===
              "PAID"
        )
      : null;

  return Boolean(
    pixTransaction
  );
}

// =====================================
// ENTREGAR PRODUTO
// =====================================

async function deliverProduct(
  merchantChargeId,
  charge
) {

  if (
    !isChargePaid(
      charge
    )
  ) {
    return false;
  }

  if (
    alreadyDelivered(
      merchantChargeId
    )
  ) {
    return true;
  }

  const order =
    getOrder(
      merchantChargeId
    );

  if (
    !order ||
    !order.discordUserId
  ) {
    return false;
  }

  const productPath =
    path.join(
      __dirname,
      "produto.txt"
    );

  if (
    !fs.existsSync(
      productPath
    )
  ) {
    throw new Error(
      "produto.txt não encontrado."
    );
  }

  const product =
    fs.readFileSync(
      productPath,
      "utf8"
    );

  const user =
    await client.users.fetch(
      order.discordUserId
    );

  await user.send(

    `✅ **Pagamento confirmado!**\n\n` +

    `Obrigado pela compra de **${PRODUCT_NAME}**.\n\n` +

    `💰 Valor: **R$ ${PRODUCT_PRICE
      .toFixed(2)
      .replace(".", ",")}**\n\n` +

    `📦 **Seu produto:**\n\n` +

    "```text\n" +

    product.slice(
      0,
      1800
    ) +

    "\n```"
  );

  markDelivered(
    merchantChargeId
  );

  console.log(
    `✅ Produto entregue: ${merchantChargeId}`
  );

  return true;
}

// =====================================
// COMANDO DISCORD
// =====================================

const commands = [

  new SlashCommandBuilder()

    .setName(
      "painelcompras"
    )

    .setDescription(
      "Envia o painel de compras"
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits
        .Administrator
    )

    .toJSON()
];

client.once(
  "ready",
  async () => {

    console.log(
      `✅ Bot online: ${client.user.tag}`
    );

    const rest =
      new REST({
        version: "10"
      })
        .setToken(
          process.env
            .BOT_TOKEN
        );

    try {

      await rest.put(

        Routes
          .applicationGuildCommands(

            process.env
              .CLIENT_ID,

            process.env
              .GUILD_ID
          ),

        {
          body:
            commands
        }
      );

      console.log(
        "✅ /painelcompras registrado."
      );

    } catch (
      error
    ) {

      console.error(
        "❌ Erro registrando comando:",
        error
      );
    }
  }
);

// =====================================
// INTERAÇÃO DISCORD
// =====================================

client.on(
  "interactionCreate",
  async interaction => {

    try {

      if (
        interaction
          .isChatInputCommand() &&

        interaction
          .commandName ===
          "painelcompras"
      ) {

        const embed =
          new EmbedBuilder()

            .setColor(
              0x21C25E
            )

            .setTitle(
              `🛒 ${PRODUCT_NAME}`
            )

            .setDescription(

              "Compra automática via **Pix**.\n\n" +

              "Você pode pagar usando **PicPay, Banco Inter, Nubank, Itaú, Caixa, Bradesco, Santander** ou outro banco com Pix.\n\n" +

              "Depois da confirmação, o produto é enviado automaticamente no seu privado."
            )

            .addFields({

              name:
                "💰 Valor",

              value:
                `R$ ${PRODUCT_PRICE
                  .toFixed(2)
                  .replace(".", ",")}`,

              inline:
                true
            })

            .setFooter({
              text:
                "Pagamento via Pix"
            });

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()

                .setCustomId(
                  "comprar_produto"
                )

                .setLabel(
                  "Comprar"
                )

                .setEmoji(
                  "🛒"
                )

                .setStyle(
                  ButtonStyle
                    .Success
                )
            );

        await interaction.reply({

          embeds:
            [embed],

          components:
            [row]
        });

        return;
      }

      if (
        interaction
          .isButton() &&

        interaction
          .customId ===
          "comprar_produto"
      ) {

        const token =
          createCheckoutToken(
            interaction
              .user
              .id
          );

        const checkoutUrl =
          `${BASE_URL}/checkout?token=${encodeURIComponent(token)}`;

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()

                .setLabel(
                  `Finalizar • R$ ${PRODUCT_PRICE
                    .toFixed(2)
                    .replace(".", ",")}`
                )

                .setEmoji(
                  "💳"
                )

                .setStyle(
                  ButtonStyle.Link
                )

                .setURL(
                  checkoutUrl
                )
            );

        await interaction.reply({

          content:
            "Clique abaixo para abrir o checkout Pix.",

          components:
            [row],

          ephemeral:
            true
        });

        return;
      }

    } catch (
      error
    ) {

      console.error(
        "❌ Erro Discord:",
        error
      );

      if (
        !interaction
          .replied &&

        !interaction
          .deferred
      ) {

        await interaction.reply({

          content:
            "❌ Ocorreu um erro.",

          ephemeral:
            true

        }).catch(
          () => {}
        );
      }
    }
  }
);

// =====================================
// SITE
// =====================================

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.send(
      page(
        "Marco Store",

        `
        <div class="brand">

          <div class="shield">
            🛡️
          </div>

          <h1>
            Marco Store
          </h1>

          <p class="muted">
            Inicie sua compra pelo Discord.
          </p>

        </div>
        `
      )
    );
  }
);

// =====================================
// CHECKOUT
// =====================================

app.get(
  "/checkout",
  (
    req,
    res
  ) => {

    const token =
      String(
        req.query
          .token || ""
      );

    if (
      !verifyCheckoutToken(
        token
      )
    ) {

      return res
        .status(400)
        .send(

          page(
            "Link inválido",

            `
            <h1>
              Link inválido ou expirado
            </h1>
            `
          )
        );
    }

    res.send(
      page(
        "Finalizar compra",

        `
        <div class="brand">

          <div class="shield">
            🛒
          </div>

          <h1>
            Finalizar compra
          </h1>

          <p class="muted">
            ${escapeHtml(PRODUCT_NAME)}
          </p>

        </div>

        <div class="price">

          R$ ${PRODUCT_PRICE
            .toFixed(2)
            .replace(".", ",")}

        </div>

        <div class="pix">

          <b>
            ✓ Pagamento via Pix
          </b>

          <p class="muted">

            Pague com PicPay, Inter, Nubank ou outro banco.

          </p>

        </div>

        <form
          method="post"
          action="/criar-pix"
        >

          <input
            type="hidden"
            name="token"
            value="${escapeHtml(token)}"
          >

          <label>
            Nome completo
          </label>

          <input
            name="name"
            required
          >

          <label>
            E-mail
          </label>

          <input
            name="email"
            type="email"
            required
          >

          <label>
            CPF
          </label>

          <input
            name="cpf"
            inputmode="numeric"
            pattern="[0-9]{11}"
            maxlength="11"
            required
          >

          <button
            type="submit"
          >
            Gerar QR Code Pix
          </button>

        </form>
        `
      )
    );
  }
);

// =====================================
// CRIAR PIX
// =====================================

app.post(
  "/criar-pix",

  async (
    req,
    res
  ) => {

    try {

      const {
        token,
        name,
        email,
        cpf
      } =
        req.body;

      const checkout =
        verifyCheckoutToken(
          token
        );

      if (
        !checkout
      ) {

        return res
          .status(400)
          .send(
            page(
              "Erro",
              "<h1>Link inválido</h1>"
            )
          );
      }

      if (
        !/^[0-9]{11}$/.test(
          String(
            cpf || ""
          )
        )
      ) {

        return res
          .status(400)
          .send(
            page(
              "Erro",
              "<h1>CPF inválido</h1>"
            )
          );
      }

      const merchantChargeId =
        crypto
          .randomUUID();

      const forwarded =
        req.headers[
          "x-forwarded-for"
        ];

      const ip =
        forwarded
          ? String(
              forwarded
            )
              .split(",")[0]
              .trim()
          : req.socket
              .remoteAddress;

      saveOrder(

        merchantChargeId,

        {

          discordUserId:
            checkout.uid,

          createdAt:
            new Date()
              .toISOString(),

          amount:
            PRODUCT_PRICE_CENTS
        }
      );

      const charge =
        await createPicPayPix({

          merchantChargeId,

          customerName:
            String(
              name
            ).trim(),

          customerEmail:
            String(
              email
            ).trim(),

          cpf:
            String(
              cpf
            ),

          ip
        });

      const pixTransaction =
        Array.isArray(
          charge.transactions
        )

          ? charge.transactions.find(

              transaction =>
                transaction.paymentType ===
                "PIX"
            )

          : null;

      const pix =
        pixTransaction
          ?.pix;

      if (
        !pix?.qrCode ||
        !pix?.qrCodeBase64
      ) {

        throw new Error(
          "PicPay não retornou QR Code."
        );
      }

      const qrSrc =
        String(
          pix.qrCodeBase64
        ).startsWith(
          "data:"
        )

          ? pix.qrCodeBase64

          : `data:image/png;base64,${pix.qrCodeBase64}`;

      res.send(

        page(
          "Pague com Pix",

          `
          <div class="brand">

            <div class="shield">
              ⚡
            </div>

            <h1>
              Pague com Pix
            </h1>

          </div>

          <div class="price">

            R$ ${PRODUCT_PRICE
              .toFixed(2)
              .replace(".", ",")}

          </div>

          <img
            class="qr"
            src="${qrSrc}"
            alt="QR Code Pix"
          >

          <label>
            Pix Copia e Cola
          </label>

          <div
            class="copy"
            id="pix-code"
          >
            ${escapeHtml(
              pix.qrCode
            )}
          </div>

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

          <div
            id="payment-status"
            class="status-wait"
          >

            ⏳ Aguardando pagamento...

          </div>

          <script>

            const merchantChargeId =
              ${JSON.stringify(
                merchantChargeId
              )};

            async function checkPayment() {

              try {

                const response =
                  await fetch(

                    '/status/' +

                    encodeURIComponent(
                      merchantChargeId
                    )
                  );

                const result =
                  await response.json();

                if (
                  result.status ===
                  'PAID'
                ) {

                  const el =
                    document.getElementById(
                      'payment-status'
                    );

                  el.className =
                    'status-ok';

                  el.innerText =
                    '✅ Pagamento confirmado! Confira sua DM no Discord.';

                  return;
                }

              } catch (
                error
              ) {}

              setTimeout(
                checkPayment,
                4000
              );
            }

            setTimeout(
              checkPayment,
              4000
            );

          </script>
          `
        )
      );

    } catch (
      error
    ) {

      console.error(
        "❌ Erro criando Pix:",
        error.response?.data ||
        error
      );

      res
        .status(500)
        .send(

          page(
            "Erro",

            `
            <h1>
              Não foi possível gerar o Pix
            </h1>
            `
          )
        );
    }
  }
);

// =====================================
// STATUS PAGAMENTO
// =====================================

app.get(
  "/status/:merchantChargeId",

  async (
    req,
    res
  ) => {

    try {

      const merchantChargeId =
        String(
          req.params
            .merchantChargeId
        );

      const order =
        getOrder(
          merchantChargeId
        );

      if (
        !order
      ) {

        return res
          .status(404)
          .json({

            error:
              "order_not_found"
          });
      }

      const charge =
        await getPicPayCharge(
          merchantChargeId
        );

      if (
        isChargePaid(
          charge
        )
      ) {

        await deliverProduct(
          merchantChargeId,
          charge
        );
      }

      res.json({

        status:
          charge
            .chargeStatus
      });

    } catch (
      error
    ) {

      console.error(
        "❌ Status:",
        error
      );

      res
        .status(500)
        .json({

          error:
            "status_error"
        });
    }
  }
);

// =====================================
// WEBHOOK PICPAY
// =====================================

app.post(
  "/webhook/picpay",

  async (
    req,
    res
  ) => {

    try {

      const authorization =
        String(
          req.headers
            .authorization ||
          ""
        );

      const expected =
        String(
          process.env
            .PICPAY_WEBHOOK_TOKEN
        );

      const received =
        authorization
          .startsWith(
            "Bearer "
          )

          ? authorization
              .slice(7)
              .trim()

          : authorization
              .trim();

      if (
        !received ||
        received !== expected
      ) {

        return res
          .sendStatus(
            401
          );
      }

      res.sendStatus(
        200
      );

      const merchantChargeId =
        String(

          req.body
            ?.data
            ?.merchantChargeId ||

          ""
        );

      if (
        !merchantChargeId
      ) {
        return;
      }

      const charge =
        await getPicPayCharge(
          merchantChargeId
        );

      if (
        isChargePaid(
          charge
        )
      ) {

        await deliverProduct(
          merchantChargeId,
          charge
        );
      }

    } catch (
      error
    ) {

      console.error(
        "❌ Webhook:",
        error
      );

      if (
        !res.headersSent
      ) {

        res.sendStatus(
          500
        );
      }
    }
  }
);

// =====================================
// START
// =====================================

app.listen(
  PORT,
  "0.0.0.0",

  () => {

    console.log(
      `🌐 Site online na porta ${PORT}`
    );

    console.log(
      `🔔 Webhook: ${BASE_URL}/webhook/picpay`
    );
  }
);

client.login(
  process.env
    .BOT_TOKEN
);
