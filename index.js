require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.options('*', cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let resolvedDbChannel = null;
let lastSyncCounts = { athletes: 0, judges: 0, scoring: 0, hasSchedule: false };
let registrationsClosed = false;
const DB_GUIDE_MARKER = 'MANABI_POWER_DB_GUIDE_V1';
const SETTINGS_ID = 'mp-event-settings';

function getServerStatus() {
    const dbChannel = getDbChannelSync();
    return {
        discordReady: client.isReady(),
        dbChannel: !!dbChannel,
        dbChannelName: dbChannel?.name || null,
        dbChannelId: DB_CHANNEL_ID || null,
        loginChannel: !!LOGIN_CHANNEL_ID,
        botTag: client.user?.tag || null,
        uptime: Math.floor(process.uptime()),
        registrationsClosed,
        counts: { ...lastSyncCounts }
    };
}

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/inscripcion', (_req, res) => {
    res.sendFile(path.join(__dirname, 'inscripcion.html'));
});

app.get('/api/status', (_req, res) => {
    res.json({ ok: true, ...getServerStatus() });
});

app.get('/api/inscripciones/status', (_req, res) => {
    res.json({
        ok: true,
        closed: registrationsClosed,
        discordReady: client.isReady(),
        dbChannel: !!getDbChannelSync()
    });
});

app.post('/api/inscripciones', async (req, res) => {
    try {
        if (registrationsClosed) {
            res.status(403).json({ ok: false, error: 'Inscripciones cerradas. Contacte a la organización del evento.' });
            return;
        }

        const dbChannel = await getDbChannel();
        if (!dbChannel) {
            res.status(503).json({ ok: false, error: 'Servicio temporalmente no disponible. Intente más tarde.' });
            return;
        }

        const body = req.body || {};
        const lastName = String(body.lastName || '').trim();
        const firstName = String(body.firstName || '').trim();
        const idCard = String(body.idCard || '').trim();
        const birthDate = String(body.birthDate || '').trim();
        const sex = String(body.sex || '').trim();
        const modality = String(body.modality || '').trim();

        const missing = [];
        if (!lastName) missing.push('apellidos');
        if (!firstName) missing.push('nombres');
        if (!idCard) missing.push('cédula');
        if (!birthDate) missing.push('fecha de nacimiento');
        if (!sex) missing.push('sexo');
        if (!modality) missing.push('modalidad');
        if (missing.length) {
            res.status(400).json({ ok: false, error: `Complete los campos obligatorios: ${missing.join(', ')}.` });
            return;
        }

        const athletes = await fetchAthletesFromDiscord();
        const nextBib = Math.max(0, ...athletes.map((a) => parseInt(a.bibNumber, 10) || 0)) + 1;
        const athleteData = {
            id: `pre-${Date.now()}`,
            bibNumber: nextBib,
            lastName,
            firstName,
            fullName: `${lastName} ${firstName}`.trim(),
            idCard,
            birthDate,
            sex,
            nationality: String(body.nationality || 'Ecuatoriana').trim() || 'Ecuatoriana',
            province: String(body.province || 'Manabí').trim() || 'Manabí',
            club: String(body.club || 'Independiente').trim() || 'Independiente',
            coach: String(body.coach || '').trim(),
            phone: String(body.phone || '').trim(),
            email: String(body.email || '').trim(),
            modality,
            height: body.height != null && body.height !== '' ? parseFloat(body.height) : null,
            weight: body.weight != null && body.weight !== '' ? parseFloat(body.weight) : null,
            category: String(body.category || 'Pendiente').trim() || 'Pendiente',
            doblajes: String(body.doblajes || '').trim(),
            athleteStatus: String(body.athleteStatus || 'Novato').trim() || 'Novato',
            classification: String(body.athleteStatus || 'Novato').trim() || 'Novato',
            passStatus: 'Sí',
            didPassWeight: 'Sí',
            paymentStatus: 'Pendiente',
            participationStatus: 'Pendiente',
            status: 'Pendiente',
            observations: String(body.observations || '').trim(),
            registrationTimestamp: Date.now(),
            source: 'pre-inscripcion'
        };

        const conflicts = findAthleteDuplicatesInList(athletes, athleteData);
        if (conflicts.length) {
            const msg = conflicts.map((c) => {
                const name = c.existing.fullName || c.existing.firstName || 'otro atleta';
                return c.type === 'bib'
                    ? `Ficha #${c.bibNumber} ya usada por ${name}`
                    : `Cédula ${c.idCard} ya registrada (${name})`;
            }).join('. ');
            res.status(409).json({ ok: false, error: msg });
            return;
        }

        await dbChannel.send(formatAthleteMessage(athleteData));
        io.emit('nuevoAtleta', athleteData);
        lastSyncCounts.athletes = athletes.length + 1;

        res.json({
            ok: true,
            bibNumber: athleteData.bibNumber,
            fullName: athleteData.fullName,
            category: athleteData.category
        });
    } catch (err) {
        console.error('POST /api/inscripciones:', err);
        res.status(500).json({ ok: false, error: 'Error al registrar. Intente de nuevo.' });
    }
});

function envPass(key, fallback) {
    const value = process.env[key];
    return (value != null && String(value).trim() !== '' ? String(value) : fallback).trim();
}

function authenticateUser(user, pass) {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const normalizedPass = String(pass || '').trim();
    const account = AUTH_USERS[normalizedUser];

    if (!normalizedUser || !normalizedPass) {
        return { ok: false, error: 'Por favor complete usuario y contraseña.' };
    }
    if (!account) {
        return { ok: false, error: 'Usuario no reconocido. Use admin, escrutador o juez1–juez9.' };
    }
    if (normalizedPass !== account.password) {
        return { ok: false, error: 'Contraseña incorrecta.' };
    }

    const token = createAuthToken();
    activeSessions.set(token, {
        user: normalizedUser,
        role: account.role,
        judgeSlot: account.judgeSlot ?? null,
        label: account.label,
        createdAt: Date.now()
    });

    return {
        ok: true,
        token,
        user: normalizedUser,
        role: account.role,
        judgeSlot: account.judgeSlot ?? null,
        label: account.label,
        discordReady: client.isReady(),
        dbChannel: !!getDbChannelSync()
    };
}

async function postLoginLog(payload) {
    if (!LOGIN_CHANNEL_ID || !client.isReady()) return;
    try {
        const channel = await client.channels.fetch(LOGIN_CHANNEL_ID);
        if (!channel?.isTextBased?.()) return;
        const { event, user, label, role, ok, detail } = payload;
        const icon = ok ? '✅' : '❌';
        const action = event === 'logout' ? 'Cierre de sesión' : (event === 'fail' ? 'Intento fallido' : 'Inicio de sesión');
        const lines = [
            `${icon} **${action}** — ${new Date().toLocaleString('es-ES')}`,
            `Usuario: \`${user}\` · ${label || role || '—'}`,
            `Rol: ${role || '—'}`,
            `Discord: ${client.isReady() ? 'conectado' : 'no disponible'}`,
            `BD: ${getDbChannelSync() ? `#${getDbChannelSync().name}` : 'no disponible'}`
        ];
        if (detail) lines.push(`Detalle: ${detail}`);
        await channel.send(lines.join('\n'));
    } catch (err) {
        console.warn('Discord: no se pudo publicar en canal login:', err.message);
    }
}

app.post('/api/login', async (req, res) => {
    const user = req.body?.user ?? req.body?.username ?? req.query?.user;
    const pass = req.body?.pass ?? req.body?.password ?? req.query?.pass;
    const result = authenticateUser(user, pass);
    if (!result.ok) {
        postLoginLog({
            event: 'fail',
            user: String(user || '').trim().toLowerCase() || '—',
            label: null,
            role: null,
            ok: false,
            detail: result.error
        }).catch(() => {});
        res.status(result.error?.includes('complete') ? 400 : 401).json(result);
        return;
    }
    await postLoginLog({
        event: 'login',
        user: result.user,
        label: result.label,
        role: result.role,
        ok: true
    });
    emitFullSync(null, { logToDiscord: false }).catch(() => {});
    res.json(result);
});

app.use(express.static(__dirname, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const LOGIN_CHANNEL_ID = process.env.LOGIN_CHANNEL_ID;
const FETCH_LIMIT = 100;
const FETCH_MAX_MESSAGES = 5000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const JUDGE_PASS = envPass('AUTH_JUDGE_PASS', 'juez2026');

const AUTH_USERS = {
    admin: { password: envPass('AUTH_ADMIN_PASS', 'raikoz7841'), role: 'admin', label: 'Administrador' },
    escrutador: { password: envPass('AUTH_SCRUT_PASS', 'scrut2026'), role: 'scrutineer', label: 'Escrutador' },
    juez1: { password: JUDGE_PASS, role: 'judge', judgeSlot: 0, label: 'Juez 1' },
    juez2: { password: JUDGE_PASS, role: 'judge', judgeSlot: 1, label: 'Juez 2' },
    juez3: { password: JUDGE_PASS, role: 'judge', judgeSlot: 2, label: 'Juez 3' },
    juez4: { password: JUDGE_PASS, role: 'judge', judgeSlot: 3, label: 'Juez 4' },
    juez5: { password: JUDGE_PASS, role: 'judge', judgeSlot: 4, label: 'Juez 5' },
    juez6: { password: JUDGE_PASS, role: 'judge', judgeSlot: 5, label: 'Juez 6' },
    juez7: { password: JUDGE_PASS, role: 'judge', judgeSlot: 6, label: 'Juez 7' },
    juez8: { password: JUDGE_PASS, role: 'judge', judgeSlot: 7, label: 'Juez 8' },
    juez9: { password: JUDGE_PASS, role: 'judge', judgeSlot: 8, label: 'Juez 9' }
};

const activeSessions = new Map();

function createAuthToken() {
    return crypto.randomUUID ? crypto.randomUUID() : `tok-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function getValidSession(token) {
    if (!token) return null;
    const session = activeSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_MAX_MS) {
        activeSessions.delete(token);
        return null;
    }
    return session;
}

function findAthleteDuplicatesInList(list, athleteData) {
    const excludeId = String(athleteData?.id || '');
    const bib = parseInt(athleteData?.bibNumber, 10);
    const idCard = String(athleteData?.idCard || '').trim();
    const conflicts = [];

    for (const a of list || []) {
        if (!a?.id || String(a.id) === excludeId) continue;
        if (bib > 0 && parseInt(a.bibNumber, 10) === bib) {
            conflicts.push({ type: 'bib', bibNumber: bib, existing: a });
        }
        if (idCard && idCard !== 'Pendiente' && String(a.idCard || '').trim() === idCard) {
            conflicts.push({ type: 'idCard', idCard, existing: a });
        }
    }
    return conflicts;
}

async function validateAthleteDuplicates(athleteData) {
    const list = await fetchAthletesFromDiscord();
    return findAthleteDuplicatesInList(list, athleteData);
}

function parseRecordMessage(content) {
    if (!content || typeof content !== 'string') return null;
    const trimmed = content.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const jsonString = fenceMatch ? fenceMatch[1].trim() : trimmed;
    if (!jsonString.startsWith('{') && !jsonString.startsWith('[')) return null;
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
}

function getRequiredBotPermissions() {
    return [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks
    ];
}

function checkBotChannelPermissions(channel) {
    if (!channel?.guild || !client.user) {
        return { ok: false, missing: ['Canal o bot no disponible'] };
    }
    const perms = channel.permissionsFor(client.user);
    if (!perms) return { ok: false, missing: ['No se pudieron leer permisos'] };
    const missing = [];
    for (const flag of getRequiredBotPermissions()) {
        if (!perms.has(flag)) missing.push(flag);
    }
    return { ok: missing.length === 0, missing };
}

async function ensureDiscordChannelSetup() {
    const dbChannel = await getDbChannel();
    if (!dbChannel) return false;

    const permCheck = checkBotChannelPermissions(dbChannel);
    if (!permCheck.ok) {
        console.warn('Discord: permisos insuficientes en el canal BD:', permCheck.missing.join(', '));
        return false;
    }

    const pinsRaw = await (dbChannel.messages.fetchPins?.() || dbChannel.messages.fetchPinned()).catch(() => null);
    const pinList = !pinsRaw ? [] : Array.isArray(pinsRaw)
        ? pinsRaw
        : typeof pinsRaw.values === 'function'
            ? [...pinsRaw.values()]
            : Array.isArray(pinsRaw.items)
                ? pinsRaw.items.map((i) => i.message || i)
                : [];
    const hasGuide = pinList.some((msg) => msg?.content?.includes(DB_GUIDE_MARKER));

    if (!hasGuide) {
        const guide = [
            DB_GUIDE_MARKER,
            '📊 **Canal Base de Datos — Manabí Power**',
            '',
            'Este canal guarda los registros de la Mesa de Control Web (**https://manabipower.com**).',
            '**No borre mensajes del bot** salvo con la web o con `!eliminar ID`.',
            '',
            '**Tipos de registro (JSON en mensajes del bot):**',
            '• Atletas — inscripciones y planillas',
            '• `recordType: "judge"` — jueces',
            '• `recordType: "scoringRound"` — calificación',
            '• `recordType: "schedule"` — cronograma',
            '',
            '**Comandos útiles:**',
            '`!ayuda` · `!estado` · `!sincronizar`',
            '`!registrar Nombre | Cédula | Modalidad | Categoría`',
            '`!eliminar ID_DEL_REGISTRO`'
        ].join('\n');

        const sent = await dbChannel.send(guide);
        await sent.pin().catch(() => {});
        console.log(`Discord: guía de canal publicada y fijada en #${dbChannel.name}`);
    }

    return true;
}

function isJudgeRecord(record) {
    return record?.recordType === 'judge';
}

function isScoringRecord(record) {
    return record?.recordType === 'scoringRound';
}

function isScheduleRecord(record) {
    return record?.recordType === 'schedule';
}

function isSettingsRecord(record) {
    return record?.recordType === 'settings';
}

function isAthleteRecord(record) {
    return record?.id && !isJudgeRecord(record) && !isScoringRecord(record) && !isScheduleRecord(record) && !isSettingsRecord(record);
}

function formatRecordMessage(record) {
    return `\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

function formatAthleteMessage(athlete) {
    const { recordType, ...rest } = athlete;
    return formatRecordMessage(rest);
}

function formatJudgeMessage(judge) {
    return formatRecordMessage({ recordType: 'judge', ...judge });
}

function formatScoringMessage(round) {
    return formatRecordMessage({ recordType: 'scoringRound', ...round });
}

function formatScheduleMessage(schedule) {
    return formatRecordMessage({ recordType: 'schedule', ...schedule });
}

function formatSettingsMessage(settings) {
    return formatRecordMessage({ recordType: 'settings', ...settings });
}

async function fetchSettingsFromDiscord() {
    const list = await fetchRecordsFromDiscord(isSettingsRecord);
    return list.find((s) => String(s.id) === SETTINGS_ID) || null;
}

async function saveSettingsToDiscord(settings) {
    const dbChannel = await getDbChannel();
    if (!dbChannel) return false;

    const existing = await findRecordMessage(SETTINGS_ID, isSettingsRecord);
    const payload = { id: SETTINGS_ID, ...settings, updatedAt: Date.now() };
    const message = formatSettingsMessage(payload);

    if (existing) await existing.message.edit(message);
    else await dbChannel.send(message);
    return true;
}

async function loadRegistrationSettings() {
    const settings = await fetchSettingsFromDiscord();
    if (settings && typeof settings.registrationsClosed === 'boolean') {
        registrationsClosed = settings.registrationsClosed;
    }
    return registrationsClosed;
}

function broadcastRegistrationStatus() {
    io.emit('inscripcionesEstado', { closed: registrationsClosed });
}

function getDbChannelSync() {
    return client.channels.cache.get(DB_CHANNEL_ID) || resolvedDbChannel || null;
}

async function getDbChannel() {
    if (!DB_CHANNEL_ID || !client.isReady()) return null;

    const cached = client.channels.cache.get(DB_CHANNEL_ID);
    if (cached) {
        resolvedDbChannel = cached;
        return cached;
    }
    if (resolvedDbChannel) return resolvedDbChannel;

    try {
        const channel = await client.channels.fetch(DB_CHANNEL_ID);
        resolvedDbChannel = channel;
        console.log(`Discord: canal BD resuelto (#${channel.name || channel.id})`);
        return channel;
    } catch (err) {
        console.warn(`Discord: no se pudo obtener canal ${DB_CHANNEL_ID}:`, err.message);
        return null;
    }
}

async function fetchAllBotMessages(dbChannel, maxMessages = FETCH_MAX_MESSAGES) {
    const all = [];
    let before;

    while (all.length < maxMessages) {
        const opts = { limit: FETCH_LIMIT };
        if (before) opts.before = before;
        const batch = await dbChannel.messages.fetch(opts);
        if (!batch.size) break;

        for (const msg of batch.values()) {
            if (msg.author.id === client.user.id) all.push(msg);
        }

        const oldest = batch.last();
        if (!oldest || batch.size < FETCH_LIMIT) break;
        before = oldest.id;
    }

    return all;
}

async function fetchRecordsFromDiscord(filterFn) {
    const dbChannel = await getDbChannel();
    if (!dbChannel) {
        console.warn('Discord: canal de BD no disponible (revisar DB_CHANNEL_ID y conexión del bot).');
        return [];
    }

    const messages = await fetchAllBotMessages(dbChannel);
    const list = [];
    const seenIds = new Set();

    [...messages].reverse().forEach((msg) => {
        const record = parseRecordMessage(msg.content);
        if (!record?.id || !filterFn(record) || seenIds.has(String(record.id))) return;
        seenIds.add(String(record.id));
        list.push(record);
    });

    return list;
}

async function fetchAthletesFromDiscord() {
    return fetchRecordsFromDiscord(isAthleteRecord);
}

async function fetchJudgesFromDiscord() {
    const list = await fetchRecordsFromDiscord(isJudgeRecord);
    return list.sort((a, b) => {
        const ao = Number(a.sortOrder);
        const bo = Number(b.sortOrder);
        const aOrder = Number.isFinite(ao) ? ao : 0;
        const bOrder = Number.isFinite(bo) ? bo : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

async function fetchScoringRoundsFromDiscord() {
    return fetchRecordsFromDiscord(isScoringRecord);
}

async function findRecordMessage(recordId, filterFn) {
    const dbChannel = await getDbChannel();
    if (!dbChannel) return null;

    const messages = await fetchAllBotMessages(dbChannel);
    for (const msg of messages) {
        const record = parseRecordMessage(msg.content);
        if (record && String(record.id) === String(recordId) && filterFn(record)) {
            return { message: msg, record };
        }
    }
    return null;
}

async function findAthleteMessage(athleteId) {
    return findRecordMessage(athleteId, isAthleteRecord);
}

async function findJudgeMessage(judgeId) {
    return findRecordMessage(judgeId, isJudgeRecord);
}

async function findScoringMessage(roundId) {
    return findRecordMessage(roundId, isScoringRecord);
}

async function findScheduleMessage(scheduleId) {
    return findRecordMessage(scheduleId, isScheduleRecord);
}

async function fetchScheduleFromDiscord() {
    const list = await fetchRecordsFromDiscord(isScheduleRecord);
    return list[0] || null;
}

async function emitAthletesList(targetSocket) {
    const list = await fetchAthletesFromDiscord();
    console.log(`Discord sync: ${list.length} atleta(s) cargado(s)`);
    if (targetSocket) targetSocket.emit('cargarAtletas', list);
    else io.emit('cargarAtletas', list);
    return list;
}

async function emitJudgesList(targetSocket) {
    const list = await fetchJudgesFromDiscord();
    console.log(`Discord sync: ${list.length} juez(es) cargado(s)`);
    if (targetSocket) targetSocket.emit('cargarJueces', list);
    else io.emit('cargarJueces', list);
    return list;
}

async function emitScoringRoundsList(targetSocket) {
    const list = await fetchScoringRoundsFromDiscord();
    if (targetSocket) targetSocket.emit('cargarCalificacion', list);
    else io.emit('cargarCalificacion', list);
    return list;
}

async function emitSchedule(targetSocket) {
    const schedule = await fetchScheduleFromDiscord();
    if (targetSocket) targetSocket.emit('cargarCronograma', schedule);
    else io.emit('cargarCronograma', schedule);
    return schedule;
}

async function fetchFullSyncPayload() {
    const dbChannel = await getDbChannel();
    const [athletes, judges, scoring, schedule] = await Promise.all([
        fetchAthletesFromDiscord(),
        fetchJudgesFromDiscord(),
        fetchScoringRoundsFromDiscord(),
        fetchScheduleFromDiscord()
    ]);
    lastSyncCounts = {
        athletes: athletes.length,
        judges: judges.length,
        scoring: scoring.length,
        hasSchedule: !!schedule
    };

    return {
        athletes,
        judges,
        scoring,
        schedule,
        registrationsClosed,
        syncedAt: Date.now(),
        discordReady: client.isReady(),
        dbChannel: !!dbChannel,
        counts: { ...lastSyncCounts }
    };
}

async function postSyncLog(summary) {
    if (!LOG_CHANNEL_ID || !client.isReady()) return;
    try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel?.isTextBased?.()) return;
        await logChannel.send(summary);
    } catch (err) {
        console.warn('Discord: no se pudo publicar en canal de logs:', err.message);
    }
}

let lastDiscordLogAt = 0;

async function emitFullSync(targetSocket, options = {}) {
    const { logToDiscord = false } = options;
    const payload = await fetchFullSyncPayload();
    const summary = `Discord sync: ${payload.athletes.length} atletas, ${payload.judges.length} jueces, ${payload.scoring.length} rondas, cronograma ${payload.schedule ? 'sí' : 'no'}`;
    console.log(summary);
    if (logToDiscord && Date.now() - lastDiscordLogAt > 15000) {
        lastDiscordLogAt = Date.now();
        await postSyncLog(`📡 **Sincronización** — ${new Date().toLocaleString('es-ES')}\n${summary.replace('Discord sync: ', '')}`);
    }
    if (targetSocket) {
        targetSocket.emit('sincronizacionCompleta', payload);
        targetSocket.emit('estadoServidor', getServerStatus());
    } else {
        io.emit('sincronizacionCompleta', payload);
        io.emit('estadoServidor', getServerStatus());
    }
    return payload;
}

let discordStartupDone = false;

async function onDiscordClientReady() {
    if (discordStartupDone) return;
    discordStartupDone = true;
    console.log(`Bot encendido: ${client.user.tag}`);
    await getDbChannel();
    const setupOk = await ensureDiscordChannelSetup();
    const status = getServerStatus();
    if (!status.dbChannel) {
        console.warn('Discord: DB_CHANNEL_ID no válido o canal no accesible. Revise .env');
    } else if (!setupOk) {
        console.warn('Discord: revise permisos del bot en el canal de base de datos.');
    }
    io.emit('estadoServidor', status);
    loadRegistrationSettings()
        .then(() => broadcastRegistrationStatus())
        .catch((err) => console.warn('No se pudo cargar estado de inscripciones:', err.message));
    emitFullSync(null, { logToDiscord: true }).catch((err) => console.error('Error en sincronización inicial:', err.message));
}

client.once('clientReady', onDiscordClientReady);
client.once('ready', onDiscordClientReady);

client.on('channelDelete', (channel) => {
    if (String(channel.id) === String(DB_CHANNEL_ID)) {
        resolvedDbChannel = null;
        io.emit('estadoServidor', getServerStatus());
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const inDbChannel = String(message.channelId) === String(DB_CHANNEL_ID);

    if (content === '!ayuda' || content === '!help') {
        return message.reply([
            '**Manabí Power — Comandos Discord**',
            '`!estado` — resumen de la base de datos',
            '`!sincronizar` — fuerza lectura desde Discord a la web',
            '`!registrar Nombre | Cédula | Modalidad | Categoría`',
            '`!eliminar ID_DEL_REGISTRO`',
            '',
            'Mesa de control: **https://manabipower.com**'
        ].join('\n'));
    }

    if (content === '!estado') {
        const payload = await fetchFullSyncPayload();
        const ch = getDbChannelSync();
        return message.reply([
            '**Estado Manabí Power**',
            `Bot: ${client.user?.tag || '—'}`,
            `Canal BD: ${ch ? `#${ch.name}` : 'no disponible'}`,
            `Atletas: **${payload.athletes.length}**`,
            `Jueces: **${payload.judges.length}**`,
            `Rondas: **${payload.scoring.length}**`,
            `Cronograma: **${payload.schedule ? 'sí' : 'no'}**`
        ].join('\n'));
    }

    if (content === '!sincronizar' || content === '!sync') {
        if (!inDbChannel) {
            return message.reply('Use este comando en el canal de base de datos o desde la web.');
        }
        await emitFullSync(null, { logToDiscord: true });
        const c = lastSyncCounts;
        return message.reply(`Sincronización enviada a la web: ${c.athletes} atletas, ${c.judges} jueces, ${c.scoring} rondas.`);
    }

    if (content.startsWith('!registrar')) {
        const args = message.content.replace('!registrar', '').split('|').map((s) => s.trim());
        if (args.length < 4) {
            return message.reply('Formato: `!registrar Nombre Completo | Cédula | Modalidad | Categoría`');
        }

        const newAthlete = {
            id: Date.now().toString(),
            fullName: args[0],
            idCard: args[1],
            modality: args[2],
            category: args[3],
            status: 'Pendiente',
            timestamp: new Date().toISOString()
        };

        const dbChannel = await getDbChannel();
        if (!dbChannel) {
            return message.reply('Error: No encuentro el canal de la Base de Datos.');
        }

        await dbChannel.send(formatAthleteMessage(newAthlete));
        message.reply(`Atleta **${args[0]}** guardado correctamente.`);
        io.emit('nuevoAtleta', newAthlete);
        emitFullSync(null, { logToDiscord: false }).catch(() => {});
        return;
    }

    if (message.content.startsWith('!eliminar')) {
        const recordId = message.content.replace('!eliminar', '').trim();
        if (!recordId) {
            return message.reply('Formato: `!eliminar ID_DEL_REGISTRO`');
        }

        const athleteFound = await findAthleteMessage(recordId);
        if (athleteFound) {
            await athleteFound.message.delete();
            io.emit('atletaEliminado', { id: recordId });
            return message.reply(`Atleta **${athleteFound.record.fullName || recordId}** eliminado.`);
        }

        const judgeFound = await findJudgeMessage(recordId);
        if (judgeFound) {
            await judgeFound.message.delete();
            io.emit('juezEliminado', { id: recordId });
            return message.reply(`Juez **${judgeFound.record.fullName || recordId}** eliminado.`);
        }

        return message.reply(`No encontré el registro con ID **${recordId}**.`);
    }
});

client.on('messageDelete', async (message) => {
    if (!message.author || message.author.id !== client.user.id) return;
    const record = parseRecordMessage(message.content);
    if (!record?.id) return;
    if (isScheduleRecord(record)) io.emit('cronogramaActualizado', null);
    else if (isScoringRecord(record)) io.emit('rondaEliminada', { id: record.id });
    else if (isJudgeRecord(record)) io.emit('juezEliminado', { id: record.id });
    else if (isAthleteRecord(record)) io.emit('atletaEliminado', { id: record.id });
});

io.on('connection', (socket) => {
    console.log('Nueva conexión desde la Mesa de Control Web');
    socket.emit('estadoServidor', getServerStatus());
    socket.emit('inscripcionesEstado', { closed: registrationsClosed });

    socket.on('intentarLogin', async (payload, callback) => {
        const result = authenticateUser(payload?.user, payload?.pass);
        if (result.ok) {
            await postLoginLog({
                event: 'login',
                user: result.user,
                label: result.label,
                role: result.role,
                ok: true,
                detail: 'vía socket'
            });
            emitFullSync(socket, { logToDiscord: false }).catch(() => {});
        } else {
            postLoginLog({
                event: 'fail',
                user: String(payload?.user || '').trim().toLowerCase() || '—',
                ok: false,
                detail: result.error
            }).catch(() => {});
        }
        callback?.(result);
    });

    socket.on('cerrarSesion', (payload) => {
        const token = payload?.token;
        const session = token ? activeSessions.get(token) : null;
        if (token) activeSessions.delete(token);
        if (session) {
            postLoginLog({
                event: 'logout',
                user: session.user,
                label: session.label,
                role: session.role,
                ok: true
            }).catch(() => {});
        }
    });

    socket.on('actualizarParticipacionDesdeWeb', async (payload) => {
        const { id, participationStatus, token } = payload || {};
        const session = getValidSession(token);
        if (!session || !['admin', 'scrutineer'].includes(session.role)) return;

        const found = await findAthleteMessage(id);
        if (!found?.record) return;

        const updated = {
            ...found.record,
            participationStatus,
            status: participationStatus,
            updatedAt: Date.now()
        };

        await found.message.edit(formatAthleteMessage(updated));
        io.emit('atletaActualizado', updated);
    });

    socket.on('solicitarAtletas', async () => {
        await emitAthletesList(socket);
    });

    socket.on('solicitarJueces', async () => {
        await emitJudgesList(socket);
    });

    socket.on('solicitarCalificacion', async () => {
        await emitScoringRoundsList(socket);
    });

    socket.on('solicitarCronograma', async () => {
        await emitSchedule(socket);
    });

    socket.on('solicitarSincronizacionCompleta', async (_payload, callback) => {
        try {
            const payload = await emitFullSync(socket);
            callback?.({
                ok: true,
                athletes: payload.athletes.length,
                judges: payload.judges.length,
                scoring: payload.scoring.length,
                hasSchedule: !!payload.schedule
            });
        } catch (err) {
            console.error('solicitarSincronizacionCompleta:', err);
            callback?.({ ok: false, error: err.message || 'Error al leer Discord' });
        }
    });

    socket.on('guardarCronogramaDesdeWeb', async (scheduleData) => {
        const dbChannel = await getDbChannel();
        if (!dbChannel || !scheduleData?.id) return;

        const existing = await findScheduleMessage(scheduleData.id);
        if (existing) {
            await existing.message.edit(formatScheduleMessage(scheduleData));
        } else {
            await dbChannel.send(formatScheduleMessage(scheduleData));
        }
        io.emit('cronogramaActualizado', scheduleData);
    });

    socket.on('actualizarEstadoInscripciones', async (payload, callback) => {
        if (typeof payload?.closed !== 'boolean') {
            callback?.({ ok: false, error: 'Estado de inscripciones inválido.' });
            return;
        }

        registrationsClosed = payload.closed;
        const saved = await saveSettingsToDiscord({ registrationsClosed });
        if (!saved) {
            callback?.({ ok: false, error: 'No se pudo guardar en Discord.' });
            return;
        }

        broadcastRegistrationStatus();
        callback?.({ ok: true, closed: registrationsClosed });
    });

    socket.on('registrarDesdeWeb', async (athleteData, callback) => {
        const dbChannel = await getDbChannel();
        if (!dbChannel || !athleteData?.id) {
            callback?.({ ok: false, error: 'Sin conexión con Discord.' });
            return;
        }

        const conflicts = await validateAthleteDuplicates(athleteData);
        if (conflicts.length) {
            const msg = conflicts.map((c) => {
                const name = c.existing.fullName || c.existing.firstName || 'otro atleta';
                return c.type === 'bib'
                    ? `Ficha #${c.bibNumber} ya usada por ${name}`
                    : `Cédula ${c.idCard} ya registrada (${name})`;
            }).join('. ');
            callback?.({ ok: false, error: msg });
            return;
        }

        const existing = await findAthleteMessage(athleteData.id);
        if (existing) {
            await existing.message.edit(formatAthleteMessage(athleteData));
            io.emit('atletaActualizado', athleteData);
            callback?.({ ok: true });
            return;
        }

        await dbChannel.send(formatAthleteMessage(athleteData));
        io.emit('nuevoAtleta', athleteData);
        callback?.({ ok: true });
    });

    socket.on('editarDesdeWeb', async (athleteData, callback) => {
        if (!athleteData?.id) {
            callback?.({ ok: false, error: 'Datos de atleta inválidos.' });
            return;
        }

        const conflicts = await validateAthleteDuplicates(athleteData);
        if (conflicts.length) {
            const msg = conflicts.map((c) => {
                const name = c.existing.fullName || c.existing.firstName || 'otro atleta';
                return c.type === 'bib'
                    ? `Ficha #${c.bibNumber} ya usada por ${name}`
                    : `Cédula ${c.idCard} ya registrada (${name})`;
            }).join('. ');
            callback?.({ ok: false, error: msg });
            return;
        }

        const found = await findAthleteMessage(athleteData.id);
        if (found) {
            await found.message.edit(formatAthleteMessage(athleteData));
            io.emit('atletaActualizado', athleteData);
            callback?.({ ok: true });
            return;
        }

        const dbChannel = await getDbChannel();
        if (!dbChannel) {
            callback?.({ ok: false, error: 'Sin conexión con Discord.' });
            return;
        }
        await dbChannel.send(formatAthleteMessage(athleteData));
        io.emit('nuevoAtleta', athleteData);
        callback?.({ ok: true });
    });

    socket.on('eliminarDesdeWeb', async (payload) => {
        const athleteId = String(payload?.id || payload || '');
        if (!athleteId) return;

        const found = await findAthleteMessage(athleteId);
        if (!found) {
            io.emit('atletaEliminado', { id: athleteId });
            return;
        }

        await found.message.delete();
        io.emit('atletaEliminado', { id: athleteId });
    });

    socket.on('vaciarDesdeWeb', async () => {
        const dbChannel = await getDbChannel();
        if (!dbChannel) return;

        const messages = await fetchAllBotMessages(dbChannel);
        for (const msg of messages) {
            const record = parseRecordMessage(msg.content);
            if (!record || !isAthleteRecord(record)) continue;
            await msg.delete().catch(() => {});
        }

        io.emit('cargarAtletas', []);
    });

    socket.on('subirRespaldoDesdeWeb', async (payload, callback) => {
        const dbChannel = await getDbChannel();
        if (!client.isReady()) {
            callback?.({ ok: false, error: 'El bot de Discord aún no está listo. Espere unos segundos e intente de nuevo.' });
            return;
        }
        if (!dbChannel) {
            callback?.({ ok: false, error: 'Canal de Discord no configurado. Revise DB_CHANNEL_ID en el servidor.' });
            return;
        }

        let athletesOk = 0;
        let judgesOk = 0;
        let scheduleOk = 0;
        let failed = 0;

        for (const athlete of payload?.athletes || []) {
            if (!athlete?.id) continue;
            try {
                const existing = await findAthleteMessage(athlete.id);
                if (existing) await existing.message.edit(formatAthleteMessage(athlete));
                else await dbChannel.send(formatAthleteMessage(athlete));
                athletesOk++;
            } catch (err) {
                console.error('Error al subir atleta desde respaldo:', athlete.id, err);
                failed++;
            }
        }

        for (const judge of payload?.judges || []) {
            if (!judge?.id) continue;
            try {
                const existing = await findJudgeMessage(judge.id);
                if (existing) await existing.message.edit(formatJudgeMessage(judge));
                else await dbChannel.send(formatJudgeMessage(judge));
                judgesOk++;
            } catch (err) {
                console.error('Error al subir juez desde respaldo:', judge.id, err);
                failed++;
            }
        }

        const scheduleData = payload?.schedule;
        if (scheduleData?.id) {
            try {
                const existing = await findScheduleMessage(scheduleData.id);
                if (existing) await existing.message.edit(formatScheduleMessage(scheduleData));
                else await dbChannel.send(formatScheduleMessage(scheduleData));
                scheduleOk = 1;
            } catch (err) {
                console.error('Error al subir cronograma desde respaldo:', err);
                failed++;
            }
        }

        let scoringOk = 0;
        for (const round of payload?.scoring || []) {
            if (!round?.id) continue;
            try {
                const existing = await findScoringMessage(round.id);
                if (existing) await existing.message.edit(formatScoringMessage(round));
                else await dbChannel.send(formatScoringMessage(round));
                scoringOk++;
            } catch (err) {
                console.error('Error al subir ronda desde respaldo:', round.id, err);
                failed++;
            }
        }

        await emitFullSync(socket, { logToDiscord: false });
        callback?.({
            ok: failed === 0,
            athletesOk,
            judgesOk,
            scheduleOk,
            scoringOk,
            failed,
            error: failed ? `${failed} registro(s) no se pudieron subir a Discord` : null
        });
    });

    socket.on('registrarJuezDesdeWeb', async (judgeData) => {
        const dbChannel = await getDbChannel();
        if (!dbChannel || !judgeData?.id) return;

        const existing = await findJudgeMessage(judgeData.id);
        if (existing) {
            await existing.message.edit(formatJudgeMessage(judgeData));
            io.emit('juezActualizado', judgeData);
            return;
        }

        await dbChannel.send(formatJudgeMessage(judgeData));
        io.emit('nuevoJuez', judgeData);
    });

    socket.on('editarJuezDesdeWeb', async (judgeData) => {
        if (!judgeData?.id) return;

        const found = await findJudgeMessage(judgeData.id);
        if (found) {
            await found.message.edit(formatJudgeMessage(judgeData));
            io.emit('juezActualizado', judgeData);
            return;
        }

        const dbChannel = await getDbChannel();
        if (!dbChannel) return;
        await dbChannel.send(formatJudgeMessage(judgeData));
        io.emit('nuevoJuez', judgeData);
    });

    socket.on('eliminarJuezDesdeWeb', async (payload) => {
        const judgeId = String(payload?.id || payload || '');
        if (!judgeId) return;

        const found = await findJudgeMessage(judgeId);
        if (!found) {
            io.emit('juezEliminado', { id: judgeId });
            return;
        }

        await found.message.delete();
        io.emit('juezEliminado', { id: judgeId });
    });

    socket.on('reordenarJuecesDesdeWeb', async (payload, callback) => {
        const dbChannel = await getDbChannel();
        if (!dbChannel) {
            callback?.({ ok: false, error: 'Sin conexión con el canal de Discord.' });
            return;
        }

        const items = payload?.judges || payload || [];
        if (!Array.isArray(items) || items.length === 0) {
            callback?.({ ok: false, error: 'Lista de jueces vacía.' });
            return;
        }

        let updated = 0;
        let failed = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item?.id) continue;
            const sortOrder = item.sortOrder != null ? item.sortOrder : i;
            const found = await findJudgeMessage(item.id);

            try {
                if (found) {
                    const { recordType, ...rest } = item;
                    const merged = { ...found.record, ...rest, sortOrder };
                    await found.message.edit(formatJudgeMessage(merged));
                    updated++;
                } else if (item.fullName || item.firstName || item.lastName) {
                    const { recordType, ...rest } = item;
                    await dbChannel.send(formatJudgeMessage({ ...rest, sortOrder }));
                    updated++;
                } else {
                    failed++;
                }
            } catch (err) {
                console.error('Error al guardar orden de juez en Discord:', item.id, err);
                failed++;
            }
        }

        const list = await fetchJudgesFromDiscord();
        io.emit('juecesReordenados', list);
        callback?.({
            ok: failed === 0,
            updated,
            failed,
            error: failed ? `${failed} juez(es) no se pudieron guardar en Discord` : null
        });
    });

    socket.on('guardarRondaDesdeWeb', async (roundData) => {
        const dbChannel = await getDbChannel();
        if (!dbChannel || !roundData?.id) return;

        const existing = await findScoringMessage(roundData.id);
        if (existing) {
            await existing.message.edit(formatScoringMessage(roundData));
            io.emit('rondaActualizada', roundData);
            return;
        }

        await dbChannel.send(formatScoringMessage(roundData));
        io.emit('nuevaRonda', roundData);
    });

    socket.on('eliminarRondaDesdeWeb', async (payload) => {
        const roundId = String(payload?.id || payload || '');
        if (!roundId) return;

        const found = await findScoringMessage(roundId);
        if (!found) {
            io.emit('rondaEliminada', { id: roundId });
            return;
        }

        await found.message.delete();
        io.emit('rondaEliminada', { id: roundId });
    });

    emitFullSync(socket).catch((err) => {
        console.error('Error al sincronizar cliente nuevo:', err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Web escuchando en el puerto ${PORT}`);
    console.log(`Mesa de control: http://localhost:${PORT}`);
});

setInterval(() => {
    if (!client.isReady()) return;
    io.emit('estadoServidor', getServerStatus());
}, 30000);

setInterval(() => {
    if (!client.isReady() || !getDbChannelSync()) return;
    emitFullSync(null, { logToDiscord: false }).catch(() => {});
}, 90000);

const discordToken = process.env.DISCORD_TOKEN;
if (!discordToken || discordToken === 'tu_token_del_bot_de_discord') {
    console.error('DISCORD_TOKEN no configurado. Edite .env con el token real del bot.');
    io.emit('estadoServidor', getServerStatus());
} else {
    client.login(discordToken).catch((err) => {
        console.error('No se pudo iniciar sesión en Discord:', err.message);
        io.emit('estadoServidor', getServerStatus());
    });
}