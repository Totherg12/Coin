import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { Rcon } from "rcon-client";

const STATE_FILE = path.resolve(process.env.STATE_FILE || "./data/state.json");
const WORDS_DEFAULT = positiveInt(process.env.WORDS_PER_REWARD, 10);
const COINS_DEFAULT = positiveInt(process.env.COINS_PER_REWARD, 5);
const RCON_TIMEOUT_MS = positiveInt(process.env.RCON_TIMEOUT_MS, 5000);
const CODE_MIN = 100000;
const CODE_MAX = 999999;

let state = {
  settings: { wordsPerReward: WORDS_DEFAULT, coinsPerReward: COINS_DEFAULT, channelIds: [] },
  players: {},
};
let saveQueue = Promise.resolve();

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function safeMinecraftName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_ .-]{1,32}$/.test(name) || name.startsWith(".") || name.includes("..")) {
    throw new Error("Nome Minecraft inválido.");
  }
  return name;
}

function makeCode() {
  return CODE_MIN + Math.floor(Math.random() * (CODE_MAX - CODE_MIN + 1));
}

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persistState();
  }
  state.settings ??= { wordsPerReward: WORDS_DEFAULT, coinsPerReward: COINS_DEFAULT, channelIds: [] };
  state.settings.wordsPerReward = positiveInt(state.settings.wordsPerReward, WORDS_DEFAULT);
  state.settings.coinsPerReward = positiveInt(state.settings.coinsPerReward, COINS_DEFAULT);
  state.settings.channelIds = Array.isArray(state.settings.channelIds) ? state.settings.channelIds : [];
  state.players ??= {};
}

function persistState() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temp, STATE_FILE);
  });
  return saveQueue;
}

async function runMinecraftCommand(command) {
  const host = process.env.RCON_HOST;
  const port = positiveInt(process.env.RCON_PORT, 19132);
  const password = process.env.RCON_PASSWORD;
  if (!host || !password) throw new Error("RCON_HOST/RCON_PASSWORD não configurados.");

  const rcon = await Rcon.connect({ host, port, password, timeout: RCON_TIMEOUT_MS });
  try {
    const response = await rcon.send(command);
    return String(response ?? "");
  } finally {
    await rcon.end().catch(() => {});
  }
}

async function verifyCodeWithMinecraft(code, minecraftName) {
  const response = await runMinecraftCommand(`scoreboard players get ${minecraftName} eterna_auth_code`);
  const numbers = [...response.matchAll(/-?\d+/g)].map(match => Number(match[0]));
  return numbers.includes(code);
}

async function markLinked(minecraftName, linked) {
  await runMinecraftCommand(`scoreboard players set ${minecraftName} eterna_linked ${linked ? 1 : 0}`);
  if (linked) await runMinecraftCommand(`scoreboard players set ${minecraftName} eterna_auth_code 0`);
}

async function reward(player, amount) {
  const name = safeMinecraftName(player.minecraftName);
  await runMinecraftCommand(`scoreboard players add ${name} eternacoins ${amount}`);
}

function getPlayer(discordId) {
  return state.players[discordId];
}

function countWords(content) {
  return content.trim() ? content.trim().split(/\s+/u).length : 0;
}

function isAllowedChannel(channelId) {
  return state.settings.channelIds.length === 0 || state.settings.channelIds.includes(channelId);
}

function adminOnly(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function commandDefinitions() {
  const config = new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configura as recompensas do servidor")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(sub => sub.setName("palavras").setDescription("Define palavras necessárias").addIntegerOption(o => o.setName("quantidade").setDescription("Quantidade de palavras").setRequired(true).setMinValue(1).setMaxValue(100000)))
    .addSubcommand(sub => sub.setName("moedas").setDescription("Define moedas entregues").addIntegerOption(o => o.setName("quantidade").setDescription("Quantidade de moedas").setRequired(true).setMinValue(1).setMaxValue(1000000000)))
    .addSubcommand(sub => sub.setName("status").setDescription("Mostra a configuração atual"))
    .addSubcommand(sub => sub.setName("canal-adicionar").setDescription("Adiciona este canal à contagem"))
    .addSubcommand(sub => sub.setName("canal-remover").setDescription("Remove este canal da contagem"))
    .addSubcommand(sub => sub.setName("canal-listar").setDescription("Lista os canais configurados"));

  return [
    new SlashCommandBuilder().setName("vincular").setDescription("Vincula Minecraft e Discord").addIntegerOption(o => o.setName("codigo").setDescription("Código exibido no Minecraft").setRequired(true).setMinValue(CODE_MIN).setMaxValue(CODE_MAX)).addStringOption(o => o.setName("jogador").setDescription("Nome exato no Minecraft").setRequired(true)),
    new SlashCommandBuilder().setName("progresso").setDescription("Mostra seu progresso de palavras"),
    new SlashCommandBuilder().setName("desvincular").setDescription("Remove um vínculo do Discord e do Minecraft").addUserOption(o => o.setName("usuario").setDescription("Usuário, somente para administradores").setRequired(false)),
    config,
  ].map(command => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: commandDefinitions() });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "vincular") {
    await interaction.deferReply({ ephemeral: true });
    const discordId = interaction.user.id;
    const existing = getPlayer(discordId);
    if (existing?.minecraftName) return interaction.editReply("Sua conta do Discord já está vinculada. Fale com um administrador se precisar corrigir o vínculo.");
    const code = interaction.options.getInteger("codigo", true);
    let minecraftName;
    try { minecraftName = safeMinecraftName(interaction.options.getString("jogador", true)); } catch (error) { return interaction.editReply(error.message); }
    try {
      if (!await verifyCodeWithMinecraft(code, minecraftName)) return interaction.editReply("Código ou jogador incorreto. Gere um novo código no Minecraft e confira o nome exato.");
      await markLinked(minecraftName, true);
      state.players[discordId] = { minecraftName, wordCount: 0, rewards: 0, linkedAt: new Date().toISOString() };
      await persistState();
      return interaction.editReply(`Vínculo concluído com **${minecraftName}**. A partir de agora suas mensagens válidas contarão para recompensas.`);
    } catch (error) {
      console.error("Falha ao vincular:", error);
      return interaction.editReply("Não consegui falar com o servidor Minecraft agora. Verifique se o RCON está ativo.");
    }
  }

  if (interaction.commandName === "progresso") {
    const player = getPlayer(interaction.user.id);
    if (!player) return interaction.reply({ content: "Sua conta ainda não está vinculada. Use `/vincular`.", ephemeral: true });
    return interaction.reply({ content: `Jogador: **${player.minecraftName}**\nProgresso: **${player.wordCount}/${state.settings.wordsPerReward}** palavras\nRecompensas recebidas: **${player.rewards || 0}**`, ephemeral: true });
  }

  if (interaction.commandName === "desvincular") {
    if (!adminOnly(interaction)) return interaction.reply({ content: "Apenas administradores podem desvincular contas.", ephemeral: true });
    const target = interaction.options.getUser("usuario") || interaction.user;
    const player = getPlayer(target.id);
    if (!player) return interaction.reply({ content: "Esse usuário não possui vínculo registrado.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      await markLinked(player.minecraftName, false);
      delete state.players[target.id];
      await persistState();
      return interaction.editReply(`Vínculo de **${player.minecraftName}** removido.`);
    } catch (error) {
      console.error("Falha ao desvincular:", error);
      return interaction.editReply("Não consegui atualizar o scoreboard no Minecraft.");
    }
  }

  if (interaction.commandName === "config") {
    if (!adminOnly(interaction)) return interaction.reply({ content: "Apenas administradores podem alterar a configuração.", ephemeral: true });
    const subcommand = interaction.options.getSubcommand();
    if (subcommand.startsWith("canal-")) {
      if (subcommand === "canal-adicionar" && !state.settings.channelIds.includes(interaction.channelId)) state.settings.channelIds.push(interaction.channelId);
      if (subcommand === "canal-remover") state.settings.channelIds = state.settings.channelIds.filter(id => id !== interaction.channelId);
      await persistState();
      if (subcommand === "canal-listar") return interaction.reply({ content: state.settings.channelIds.length ? `Canais: ${state.settings.channelIds.map(id => `<#${id}>`).join(", ")}` : "Todos os canais estão liberados.", ephemeral: true });
      return interaction.reply({ content: subcommand === "canal-adicionar" ? "Este canal agora conta palavras." : "Este canal foi retirado da contagem.", ephemeral: true });
    }
    if (subcommand === "palavras") state.settings.wordsPerReward = interaction.options.getInteger("quantidade", true);
    if (subcommand === "moedas") state.settings.coinsPerReward = interaction.options.getInteger("quantidade", true);
    if (subcommand === "status") return interaction.reply({ content: `Configuração: **${state.settings.wordsPerReward}** palavras = **${state.settings.coinsPerReward}** EternaCoins.`, ephemeral: true });
    await persistState();
    return interaction.reply({ content: "Configuração atualizada.", ephemeral: true });
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", async readyClient => {
  console.log(`Bot conectado como ${readyClient.user.tag}`);
  await registerCommands();
  console.log("Comandos slash registrados.");
});

client.on("interactionCreate", interaction => handleInteraction(interaction).catch(error => console.error("Interação falhou:", error)));

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild || !isAllowedChannel(message.channelId)) return;
  const player = getPlayer(message.author.id);
  if (!player) return;
  const words = countWords(message.content);
  if (!words) return;
  player.wordCount += words;
  const limit = state.settings.wordsPerReward;
  let rewards = 0;
  while (player.wordCount >= limit) {
    player.wordCount -= limit;
    rewards += 1;
  }
  if (!rewards) return persistState();
  const totalCoins = rewards * state.settings.coinsPerReward;
  try {
    await reward(player, totalCoins);
    player.rewards = (player.rewards || 0) + rewards;
    await persistState();
    await message.react("✅").catch(() => {});
  } catch (error) {
    player.wordCount += rewards * limit;
    await persistState();
    console.error(`Falha ao pagar ${player.minecraftName}:`, error);
  }
});

process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));

await loadState();
if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) throw new Error("DISCORD_TOKEN e DISCORD_CLIENT_ID são obrigatórios.");
await client.login(process.env.DISCORD_TOKEN);
