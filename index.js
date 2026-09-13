require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require("discord.js");

const required = ["BOT_TOKEN", "CLIENT_ID", "GUILD_ID", "SUPPORT_ROLE_ID"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Falta ${key} no arquivo .env`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const counterFile = path.join(__dirname, "ticket-counter.json");

function nextTicketNumber() {
  let data = { lastTicket: 0 };

  try {
    if (fs.existsSync(counterFile)) {
      data = JSON.parse(fs.readFileSync(counterFile, "utf8"));
    }
  } catch {}

  data.lastTicket = Number(data.lastTicket || 0) + 1;
  fs.writeFileSync(counterFile, JSON.stringify(data, null, 2), "utf8");
  return data.lastTicket;
}

const commands = [
  new SlashCommandBuilder()
    .setName("painelsuporte")
    .setDescription("Envia o painel do sistema de tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON()
];

client.once("ready", async () => {
  console.log(`Bot de suporte conectado como ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Comando /painelsuporte registrado.");
  } catch (err) {
    console.error("Erro ao registrar comando:", err);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "painelsuporte") {
      const embed = new EmbedBuilder()
        .setColor(0x2B7FFF)
        .setTitle(`🎟️ ${process.env.PANEL_TITLE || "Central de Suporte"}`)
        .setDescription(process.env.PANEL_MESSAGE || "Clique no botão abaixo para abrir um ticket.")
        .addFields(
          {
            name: "🔒 Atendimento privado",
            value: "Somente você e a equipe de suporte poderão visualizar seu ticket."
          },
          {
            name: "⚡ Como funciona?",
            value: "Clique em **Abrir Ticket**, explique seu problema e aguarde a equipe."
          }
        )
        .setFooter({ text: process.env.PANEL_FOOTER || "Sistema de suporte" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("abrir_ticket")
          .setLabel("Abrir Ticket")
          .setEmoji("🎟️")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.isButton() && interaction.customId === "abrir_ticket") {
      const guild = interaction.guild;

      const existing = guild.channels.cache.find(ch =>
        ch.type === ChannelType.GuildText &&
        ch.topic === `ticket-owner:${interaction.user.id}`
      );

      if (existing) {
        await interaction.reply({
          content: `⚠️ Você já tem um ticket aberto: ${existing}`,
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const number = nextTicketNumber();

      const overwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        },
        {
          id: process.env.SUPPORT_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ];

      const createOptions = {
        name: `ticket-${number}`,
        type: ChannelType.GuildText,
        topic: `ticket-owner:${interaction.user.id}`,
        permissionOverwrites: overwrites
      };

      if (process.env.TICKET_CATEGORY_ID) {
        createOptions.parent = process.env.TICKET_CATEGORY_ID;
      }

      const channel = await guild.channels.create(createOptions);

      const ticketEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`🎟️ Ticket #${number}`)
        .setDescription(
          `${interaction.user}, seu ticket foi criado.\n\n` +
          `${process.env.TICKET_WELCOME || "Explique como podemos ajudar."}`
        )
        .addFields(
          { name: "👤 Cliente", value: `${interaction.user}`, inline: true },
          { name: "🛠️ Suporte", value: `<@&${process.env.SUPPORT_ROLE_ID}>`, inline: true }
        )
        .setFooter({ text: "Use o botão abaixo para encerrar o atendimento." });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fechar_ticket")
          .setLabel("Fechar Ticket")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({
        content: `${interaction.user} <@&${process.env.SUPPORT_ROLE_ID}>`,
        embeds: [ticketEmbed],
        components: [closeRow],
        allowedMentions: {
          users: [interaction.user.id],
          roles: [process.env.SUPPORT_ROLE_ID]
        }
      });

      await interaction.editReply({
        content: `✅ Ticket criado: ${channel}`
      });

      return;
    }

    if (interaction.isButton() && interaction.customId === "fechar_ticket") {
      const channel = interaction.channel;

      if (!channel?.topic?.startsWith("ticket-owner:")) {
        await interaction.reply({
          content: "Esse botão só funciona dentro de um ticket.",
          ephemeral: true
        });
        return;
      }

      const ownerId = channel.topic.replace("ticket-owner:", "");
      const member = interaction.member;

      const canClose =
        interaction.user.id === ownerId ||
        member.roles.cache.has(process.env.SUPPORT_ROLE_ID) ||
        member.permissions.has(PermissionFlagsBits.Administrator);

      if (!canClose) {
        await interaction.reply({
          content: "❌ Você não pode fechar este ticket.",
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: "🔒 Ticket fechado. O canal será apagado em 5 segundos."
      });

      setTimeout(async () => {
        try {
          await channel.delete("Ticket encerrado");
        } catch (err) {
          console.error("Erro ao apagar canal:", err);
        }
      }, 5000);
    }
  } catch (err) {
    console.error("Erro:", err);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Ocorreu um erro. Confira as permissões do bot.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.login(process.env.BOT_TOKEN);
