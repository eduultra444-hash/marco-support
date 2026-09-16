require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
for (const key of ["BOT_TOKEN", "CLIENT_ID", "GUILD_ID", "SUPPORT_ROLE_ID"]) { if (!process.env[key]) { console.error("Falta configurar " + key + "."); process.exit(1); } }
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const counterFile = path.join(__dirname, "ticket-counter.json");
function nextTicketNumber() { try { const data = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, "utf8")) : {}; const next = Number(data.lastTicket || 0) + 1; fs.writeFileSync(counterFile, JSON.stringify({ lastTicket: next }, null, 2)); return next; } catch (error) { console.error(error); return Date.now(); } }
http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Marco Support está online."); }).listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Site de status online."));
const commands = [new SlashCommandBuilder().setName("painelsuporte").setDescription("Envia o painel do sistema de tickets").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON()];
client.once("ready", async () => { console.log("Bot conectado como " + client.user.tag); try { const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN); await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands }); console.log("/painelsuporte registrado."); } catch (error) { console.error("Erro ao registrar comando:", error); } });
client.on("interactionCreate", async interaction => { try {
  if (interaction.isChatInputCommand() && interaction.commandName === "painelsuporte") {
    const embed = new EmbedBuilder().setColor(0x2b7fff).setTitle("🎟️ " + (process.env.PANEL_TITLE || "Central de Suporte")).setDescription(process.env.PANEL_MESSAGE || "Precisa de ajuda? Clique no botão abaixo para abrir um ticket privado.").addFields({ name: "🔒 Atendimento privado", value: "Somente você e a equipe de suporte poderão visualizar o ticket." }, { name: "⚡ Como funciona?", value: "Clique em **Abrir Ticket**, explique o problema e aguarde a equipe." }).setFooter({ text: process.env.PANEL_FOOTER || "Marco Store • Suporte" });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("abrir_ticket").setLabel("Abrir Ticket").setEmoji("🎟️").setStyle(ButtonStyle.Primary));
    return interaction.reply({ embeds: [embed], components: [row] });
  }
  if (interaction.isButton() && interaction.customId === "abrir_ticket") {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Este botão só funciona no servidor.", ephemeral: true });
    const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic === "ticket-owner:" + interaction.user.id);
    if (existing) return interaction.reply({ content: "⚠️ Você já possui um ticket aberto: " + existing, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const number = nextTicketNumber();
    const channel = await guild.channels.create({ name: "ticket-" + number, type: ChannelType.GuildText, topic: "ticket-owner:" + interaction.user.id, parent: process.env.TICKET_CATEGORY_ID || undefined, permissionOverwrites: [ { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }, { id: process.env.SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] } ] });
    const ticket = new EmbedBuilder().setColor(0x57f287).setTitle("🎟️ Ticket #" + number).setDescription(interaction.user + ", seu ticket foi criado. " + (process.env.TICKET_WELCOME || "Explique aqui como podemos ajudar.")).setFooter({ text: "Somente a equipe de suporte pode fechar este ticket." });
    const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("fechar_ticket").setLabel("Fechar Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger));
    await channel.send({ content: interaction.user + " <@&" + process.env.SUPPORT_ROLE_ID + ">", embeds: [ticket], components: [closeRow], allowedMentions: { users: [interaction.user.id], roles: [process.env.SUPPORT_ROLE_ID] } });
    return interaction.editReply({ content: "✅ Seu ticket foi criado: " + channel });
  }
  if (interaction.isButton() && interaction.customId === "fechar_ticket") {
    const channel = interaction.channel;
    if (!channel?.topic?.startsWith("ticket-owner:")) return interaction.reply({ content: "❌ Esse botão só funciona dentro de um ticket.", ephemeral: true });
    const roles = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : (interaction.member?.roles || []);
    if (!roles.includes(process.env.SUPPORT_ROLE_ID)) return interaction.reply({ content: "❌ Somente o cargo de **Suporte** pode fechar tickets.", ephemeral: true });
    await interaction.reply("🔒 Ticket encerrado pela equipe de suporte. O canal será apagado em 5 segundos.");
    setTimeout(() => channel.delete("Ticket encerrado pelo suporte").catch(console.error), 5000);
  }
} catch (error) { console.error("Erro na interação:", error); if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Ocorreu um erro. Confira as permissões e IDs configurados.", ephemeral: true }).catch(() => {}); } });
client.login(process.env.BOT_TOKEN);
