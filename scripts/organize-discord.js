/**
 * Verifica y organiza el canal de Discord para Manabí Power.
 * Uso: node scripts/organize-discord.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
} = require('discord.js');

const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DB_GUIDE_MARKER = 'MANABI_POWER_DB_GUIDE_V1';

const REQUIRED_PERMS = [
    ['Ver canal', PermissionFlagsBits.ViewChannel],
    ['Enviar mensajes', PermissionFlagsBits.SendMessages],
    ['Leer historial', PermissionFlagsBits.ReadMessageHistory],
    ['Gestionar mensajes', PermissionFlagsBits.ManageMessages],
    ['Fijar mensajes', PermissionFlagsBits.ManageMessages],
    ['Insertar enlaces', PermissionFlagsBits.EmbedLinks],
];

function fail(msg) {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
}

function ok(msg) {
    console.log(`✓ ${msg}`);
}

function warn(msg) {
    console.warn(`⚠ ${msg}`);
}

async function main() {
    console.log('=== Manabí Power — Organizar Discord ===\n');

    if (!DISCORD_TOKEN || DISCORD_TOKEN === 'tu_token_del_bot_de_discord') {
        fail('DISCORD_TOKEN no configurado en .env');
    }
    if (!DB_CHANNEL_ID || DB_CHANNEL_ID === 'id_del_canal_donde_se_guardan_los_atletas') {
        fail('DB_CHANNEL_ID no configurado en .env');
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });

    await client.login(DISCORD_TOKEN);
    await new Promise((resolve) => {
        if (client.isReady()) resolve();
        else client.once('ready', resolve);
    });

    ok(`Bot conectado: ${client.user.tag}`);

    let channel;
    try {
        channel = await client.channels.fetch(DB_CHANNEL_ID);
    } catch (err) {
        fail(`No se pudo acceder al canal ${DB_CHANNEL_ID}: ${err.message}`);
    }

    if (!channel?.isTextBased?.()) {
        fail('DB_CHANNEL_ID no apunta a un canal de texto.');
    }

    ok(`Canal BD: #${channel.name} (${channel.id})`);
    if (channel.guild) {
        ok(`Servidor: ${channel.guild.name} (${channel.guild.id})`);
    }

    const perms = channel.permissionsFor(client.user);
    let permsOk = true;
    for (const [label, flag] of REQUIRED_PERMS) {
        if (perms?.has(flag)) ok(`Permiso: ${label}`);
        else {
            warn(`Falta permiso: ${label}`);
            permsOk = false;
        }
    }

    if (!permsOk) {
        warn('En Discord: Configuración del servidor → Roles → Manabi Power → active los permisos anteriores en el canal BD.');
    }

    const pins = await (channel.messages.fetchPins?.() || channel.messages.fetchPinned()).catch(() => null);
    const hasGuide = pins?.some((m) => m.content.includes(DB_GUIDE_MARKER));

    if (hasGuide) {
        ok('Guía del canal ya está fijada.');
    } else {
        const guide = [
            DB_GUIDE_MARKER,
            '📊 **Canal Base de Datos — Manabí Power**',
            '',
            'Registros sincronizados con **https://manabipower.com**',
            'No borre mensajes del bot manualmente.',
            '',
            'Comandos: `!ayuda` `!estado` `!sincronizar`',
            '`!registrar Nombre | Cédula | Modalidad | Categoría`',
            '`!eliminar ID`',
        ].join('\n');
        const sent = await channel.send(guide);
        await sent.pin().catch(() => warn('No se pudo fijar la guía (falta Manage Messages).'));
        ok('Guía publicada en el canal BD.');
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    let athletes = 0;
    let judges = 0;
    let scoring = 0;
    let schedule = 0;
    let invalid = 0;

    for (const msg of messages.values()) {
        if (msg.author.id !== client.user.id) continue;
        const raw = msg.content.trim();
        const match = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        const jsonStr = match ? match[1].trim() : raw;
        if (!jsonStr.startsWith('{')) {
            invalid++;
            continue;
        }
        try {
            const record = JSON.parse(jsonStr);
            if (record.recordType === 'judge') judges++;
            else if (record.recordType === 'scoringRound') scoring++;
            else if (record.recordType === 'schedule') schedule++;
            else if (record.id) athletes++;
        } catch {
            invalid++;
        }
    }

    console.log('\n--- Resumen (últimos 100 mensajes del bot) ---');
    console.log(`  Atletas:     ${athletes}`);
    console.log(`  Jueces:      ${judges}`);
    console.log(`  Rondas:      ${scoring}`);
    console.log(`  Cronograma:  ${schedule}`);
    if (invalid) warn(`Mensajes no JSON válidos: ${invalid}`);

    console.log('\n--- Estructura recomendada del servidor Discord ---');
    console.log('  📊 MANABI POWER — DATOS');
    console.log('    └ #base-de-datos  ← DB_CHANNEL_ID (solo bot escribe)');
    console.log('  📢 MANABI POWER — COMUNICACIÓN');
    console.log('    └ #mesa-de-control  (enlace a manabipower.com)');
    console.log('    └ #anuncios');
    console.log('\nListo. Inicie el servidor con: npm start');
    console.log('Abra: http://localhost:3000 o https://manabipower.com\n');

    await client.destroy();
}

main().catch((err) => fail(err.message));