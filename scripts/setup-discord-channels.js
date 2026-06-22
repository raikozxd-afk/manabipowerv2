/**
 * Crea y organiza canales de texto en el servidor Discord de Manabí Power.
 * Uso: node scripts/setup-discord-channels.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID;
const ENV_PATH = path.join(__dirname, '..', '.env');

const SERVER_LAYOUT = [
    {
        category: '📊 MANABI POWER — SISTEMA',
        channels: [
            {
                name: 'base-de-datos',
                topic: 'Registros JSON sincronizados con manabipower.com — no borrar mensajes del bot',
                pin: [
                    '🔒 **Canal de base de datos**',
                    'Aquí el bot guarda atletas, jueces, calificación y cronograma.',
                    '**No elimine mensajes del bot.** Use la web o `!eliminar ID`.',
                    'https://manabipower.com'
                ],
                isDbChannel: true,
                everyoneCanSend: false,
            },
            {
                name: 'logs-sincronizacion',
                topic: 'Registro de sincronizaciones entre Discord y la Mesa de Control',
                pin: [
                    '📡 **Logs de sincronización**',
                    'El bot publicará aquí resúmenes cuando la web sincronice datos.',
                ],
                envKey: 'LOG_CHANNEL_ID',
            },
            {
                name: 'comandos-bot',
                topic: 'Comandos del bot Manabí Power',
                pin: [
                    '🤖 **Comandos disponibles**',
                    '`!ayuda` — lista de comandos',
                    '`!estado` — resumen de registros',
                    '`!sincronizar` — forzar sync con la web',
                    '`!registrar Nombre | Cédula | Modalidad | Categoría`',
                    '`!eliminar ID_DEL_REGISTRO`',
                ],
            },
            {
                name: 'login',
                topic: 'Accesos a la Mesa de Control Web — manabipower.com',
                pin: [
                    '🔐 **Canal de login**',
                    'Aquí se registran los accesos a **https://manabipower.com**',
                    'Cada inicio y cierre de sesión queda sincronizado con Discord.',
                ],
                envKey: 'LOGIN_CHANNEL_ID',
                everyoneCanSend: false,
            },
            {
                name: 'pre-inscripciones',
                topic: 'Pre-inscripciones web — manabipower.com/inscripcion (pendientes de confirmación)',
                pin: [
                    '📝 **Canal de pre-inscripciones**',
                    'Los deportistas que envían el formulario en **https://manabipower.com/inscripcion** aparecen aquí.',
                    '**No se mezclan** con los atletas oficiales de #base-de-datos.',
                    'Cuando confirme pago o datos, regístrelo en la Mesa de Control web.',
                ],
                envKey: 'PRE_INSCRIPTION_CHANNEL_ID',
                everyoneCanSend: false,
            },
        ],
    },
    {
        category: '🏋️ MANABI POWER — COMPETENCIA',
        channels: [
            {
                name: 'atletas',
                topic: 'Inscripciones, fichas y novedades de atletas',
                pin: [
                    '🏋️ **Canal de atletas**',
                    'Consultas de inscripción, fichas y categorías.',
                    'Los datos oficiales se gestionan en **https://manabipower.com**',
                    'Registro rápido por Discord (canal #comandos-bot):',
                    '`!registrar Nombre | Cédula | Modalidad | Categoría`',
                ],
            },
            {
                name: 'jueces',
                topic: 'Mesa de jueces, orden y calificación',
                pin: [
                    '⚖️ **Canal de jueces**',
                    'Coordinación de la mesa técnica y orden de jueces.',
                    'Acceso web: usuarios `juez1` … `juez9` en manabipower.com',
                ],
            },
            {
                name: 'cronograma-horarios',
                topic: 'Horarios, modalidades y orden del evento',
                pin: [
                    '📅 **Cronograma y horarios**',
                    'Publicación del orden del día y cambios de horario.',
                    'Edición oficial en la sección Cronograma de la web.',
                ],
            },
            {
                name: 'calificacion-resultados',
                topic: 'Puntajes, rondas y resultados del torneo',
                pin: [
                    '🏆 **Calificación y resultados**',
                    'Resumen de puntajes y resultados por modalidad.',
                    'Datos en tiempo real en la Mesa de Control web.',
                ],
            },
        ],
    },
    {
        category: '📢 MANABI POWER — COMUNICACIÓN',
        channels: [
            {
                name: 'anuncios',
                topic: 'Anuncios oficiales del evento Manabí Power',
                pin: [
                    '📢 **Anuncios oficiales**',
                    'Solo staff: publicar avisos importantes del torneo.',
                ],
                everyoneCanSend: false,
            },
            {
                name: 'mesa-de-control',
                topic: 'Enlace y acceso a la Mesa de Control Web',
                pin: [
                    '🖥️ **Mesa de Control Web**',
                    '**https://manabipower.com**',
                    '',
                    'Usuarios: `admin`, `escrutador`, `juez1`–`juez9`',
                    'Sincronizado en tiempo real con Discord.',
                ],
            },
        ],
    },
    {
        category: '💬 MANABI POWER — COMUNIDAD',
        channels: [
            {
                name: 'general',
                topic: 'Chat general de Manabí Power',
                pin: [
                    '👋 **Bienvenidos a Manabí Power**',
                    'Servidor oficial del torneo. Consulte #anuncios y #mesa-de-control.',
                ],
            },
            {
                name: 'soporte',
                topic: 'Ayuda técnica con la web y Discord',
                pin: [
                    '🛟 **Soporte**',
                    'Problemas con login, sincronización o la web — escriba aquí.',
                    'Admin: revise #logs-sincronizacion y `!estado` en #comandos-bot.',
                ],
            },
        ],
    },
];

function log(icon, msg) {
    console.log(`${icon} ${msg}`);
}

function normalizeName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

async function waitReady(client) {
    if (client.isReady()) return;
    await new Promise((resolve) => client.once('ready', resolve));
}

async function findCategory(guild, name) {
    return guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === name
    );
}

async function findTextChannel(guild, name, parentId = null) {
    const target = normalizeName(name);
    return guild.channels.cache.find((c) => {
        if (c.type !== ChannelType.GuildText) return false;
        if (parentId && c.parentId !== parentId) return false;
        return normalizeName(c.name) === target || c.name === name;
    });
}

async function ensureCategory(guild, name) {
    let category = await findCategory(guild, name);
    if (category) {
        log('✓', `Categoría existente: ${name}`);
        return category;
    }
    category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: 'Organización Manabí Power',
    });
    log('+', `Categoría creada: ${name}`);
    return category;
}

async function ensureTextChannel(guild, category, spec, createdMap) {
    const { name, topic, everyoneCanSend = true } = spec;
    let channel = await findTextChannel(guild, name, category.id);

    if (!channel && spec.isDbChannel && DB_CHANNEL_ID) {
        try {
            const existing = await guild.channels.fetch(DB_CHANNEL_ID);
            if (existing?.isTextBased?.()) {
                channel = existing;
                if (channel.parentId !== category.id || channel.name !== name) {
                    await channel.edit({
                        name,
                        topic: topic || channel.topic,
                        parent: category.id,
                        reason: 'Renombrar canal BD Manabí Power',
                    });
                    log('↻', `Canal BD reorganizado: #${name}`);
                } else {
                    log('✓', `Canal BD ya en su lugar: #${name}`);
                }
            }
        } catch {
            /* crear nuevo abajo */
        }
    }

    if (!channel) {
        const overwrites = [
            {
                id: guild.roles.everyone.id,
                deny: everyoneCanSend ? [] : [PermissionFlagsBits.SendMessages],
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            },
            {
                id: guild.client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.PinMessages,
                ],
            },
        ];

        channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: category.id,
            topic,
            permissionOverwrites: overwrites,
            reason: 'Organización Manabí Power',
        });
        log('+', `Canal creado: #${name}`);
    } else {
        const updates = {};
        if (channel.parentId !== category.id) updates.parent = category.id;
        if (topic && channel.topic !== topic) updates.topic = topic;
        if (channel.name !== name) updates.name = name;
        if (Object.keys(updates).length) {
            await channel.edit({ ...updates, reason: 'Actualizar canal Manabí Power' });
            log('↻', `Canal actualizado: #${name}`);
        } else {
            log('✓', `Canal existente: #${name}`);
        }
    }

    createdMap[name] = channel.id;
    if (spec.isDbChannel) createdMap.__dbChannelId = channel.id;
    if (spec.envKey) createdMap[spec.envKey] = channel.id;

    if (spec.pin?.length) {
        const marker = `MANABI_PIN_${normalizeName(name).toUpperCase()}`;
        const pinsRaw = await (channel.messages.fetchPins?.() || channel.messages.fetchPinned()).catch(() => null);
        const pinList = !pinsRaw ? [] : Array.isArray(pinsRaw)
            ? pinsRaw
            : typeof pinsRaw.values === 'function'
                ? [...pinsRaw.values()]
                : Array.isArray(pinsRaw.items)
                    ? pinsRaw.items.map((i) => i.message || i)
                    : [];
        const hasPin = pinList.some((m) => m?.content?.includes(marker));
        if (!hasPin) {
            const content = [marker, ...spec.pin].join('\n');
            const sent = await channel.send(content);
            await sent.pin().catch(() => log('⚠', `No se pudo fijar mensaje en #${name}`));
            log('📌', `Guía fijada en #${name}`);
        }
    }

    return channel;
}

function updateEnvFile(updates) {
    if (!fs.existsSync(ENV_PATH)) return;
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    let changed = false;

    for (const [key, value] of Object.entries(updates)) {
        if (!value) continue;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            const next = content.replace(regex, `${key}=${value}`);
            if (next !== content) {
                content = next;
                changed = true;
            }
        } else {
            content += `\n${key}=${value}`;
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(ENV_PATH, content.trim() + '\n', 'utf8');
        log('✓', 'Archivo .env actualizado con IDs de canales');
    }
}

async function main() {
    console.log('\n=== Manabí Power — Crear canales Discord ===\n');

    if (!DISCORD_TOKEN || DISCORD_TOKEN === 'tu_token_del_bot_de_discord') {
        console.error('✗ Configure DISCORD_TOKEN en .env');
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });

    await client.login(DISCORD_TOKEN);
    await waitReady(client);
    log('✓', `Bot: ${client.user.tag}`);

    let guild;
    if (DB_CHANNEL_ID) {
        const dbCh = await client.channels.fetch(DB_CHANNEL_ID).catch(() => null);
        guild = dbCh?.guild || null;
    }
    if (!guild) {
        const guilds = [...client.guilds.cache.values()];
        if (guilds.length === 1) guild = guilds[0];
        else if (guilds.length > 1) {
            guild = guilds.find((g) => /manabi/i.test(g.name)) || guilds[0];
        }
    }
    if (!guild) {
        console.error('✗ El bot no está en ningún servidor Discord.');
        process.exit(1);
    }

    await guild.channels.fetch();
    log('✓', `Servidor: ${guild.name}`);

    const botPerms = guild.members.me?.permissions;
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
        console.error('✗ El bot necesita permiso **Gestionar canales** en el servidor.');
        console.error('  Discord → Configuración del servidor → Roles → Manabi Power → Gestionar canales');
        process.exit(1);
    }

    const createdMap = {};

    for (const section of SERVER_LAYOUT) {
        console.log('');
        const category = await ensureCategory(guild, section.category);
        for (const chSpec of section.channels) {
            await ensureTextChannel(guild, category, chSpec, createdMap);
        }
    }

    const envUpdates = {};
    if (createdMap.__dbChannelId) envUpdates.DB_CHANNEL_ID = createdMap.__dbChannelId;
    if (createdMap.LOG_CHANNEL_ID) envUpdates.LOG_CHANNEL_ID = createdMap.LOG_CHANNEL_ID;
    if (createdMap.LOGIN_CHANNEL_ID) envUpdates.LOGIN_CHANNEL_ID = createdMap.LOGIN_CHANNEL_ID;
    if (createdMap.PRE_INSCRIPTION_CHANNEL_ID) envUpdates.PRE_INSCRIPTION_CHANNEL_ID = createdMap.PRE_INSCRIPTION_CHANNEL_ID;
    if (createdMap.ANNOUNCE_CHANNEL_ID) envUpdates.ANNOUNCE_CHANNEL_ID = createdMap.ANNOUNCE_CHANNEL_ID;
    updateEnvFile(envUpdates);

    console.log('\n--- Resumen ---');
    for (const section of SERVER_LAYOUT) {
        for (const ch of section.channels) {
            const id = createdMap[ch.name];
            if (id) console.log(`  #${ch.name.padEnd(22)} ${id}`);
        }
    }
    if (createdMap.LOG_CHANNEL_ID) {
        console.log(`  LOG_CHANNEL_ID (env)     ${createdMap.LOG_CHANNEL_ID}`);
    }
    if (createdMap.LOGIN_CHANNEL_ID) {
        console.log(`  LOGIN_CHANNEL_ID (env)   ${createdMap.LOGIN_CHANNEL_ID}`);
    }
    if (createdMap.PRE_INSCRIPTION_CHANNEL_ID) {
        console.log(`  PRE_INSCRIPTION_CHANNEL_ID ${createdMap.PRE_INSCRIPTION_CHANNEL_ID}`);
    }
    console.log('\nListo. Abra Discord y revise las categorías creadas.');
    console.log('Luego: npm start → http://localhost:3000\n');

    await client.destroy();
}

main().catch((err) => {
    console.error('✗', err.message);
    process.exit(1);
});