require('dotenv').config();
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

let resolvedDbChannel = null;

function getServerStatus() {
    return {
        discordReady: client.isReady(),
        dbChannel: !!getDbChannelSync(),
        botTag: client.user?.tag || null,
        uptime: Math.floor(process.uptime())
    };
}

app.get('/api/status', (_req, res) => {
    res.json({ ok: true, ...getServerStatus() });
});

function authenticateUser(user, pass) {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const normalizedPass = String(pass || '').trim();
    const account = AUTH_USERS[normalizedUser];

    if (!normalizedUser || !normalizedPass) {
        return { ok: false, error: 'Por favor complete usuario y contraseña.' };
    }
    if (!account || normalizedPass !== account.password) {
        return { ok: false, error: 'Usuario o contraseña incorrectos.' };
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
        label: account.label
    };
}

app.post('/api/login', (req, res) => {
    const result = authenticateUser(req.body?.user, req.body?.pass);
    if (!result.ok) {
        res.status(result.error?.includes('complete') ? 400 : 401).json(result);
        return;
    }
    res.json(result);
});

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
const FETCH_LIMIT = 100;
const FETCH_MAX_MESSAGES = 5000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const JUDGE_PASS = process.env.AUTH_JUDGE_PASS || 'juez2026';

const AUTH_USERS = {
    admin: { password: process.env.AUTH_ADMIN_PASS || 'raikoz7841', role: 'admin', label: 'Administrador' },
    escrutador: { password: process.env.AUTH_SCRUT_PASS || 'scrut2026', role: 'scrutineer', label: 'Escrutador' },
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
    if (!content || !content.startsWith('```json')) return null;
    const jsonString = content.replace('```json\n', '').replace('\n```', '').trim();
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
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

function isAthleteRecord(record) {
    return record?.id && !isJudgeRecord(record) && !isScoringRecord(record) && !isScheduleRecord(record);
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
    return {
        athletes,
        judges,
        scoring,
        schedule,
        syncedAt: Date.now(),
        discordReady: client.isReady(),
        dbChannel: !!dbChannel
    };
}

async function emitFullSync(targetSocket) {
    const payload = await fetchFullSyncPayload();
    console.log(`Discord sync completa: ${payload.athletes.length} atletas, ${payload.judges.length} jueces, ${payload.scoring.length} rondas, cronograma ${payload.schedule ? 'sí' : 'no'}`);
    if (targetSocket) {
        targetSocket.emit('sincronizacionCompleta', payload);
        targetSocket.emit('estadoServidor', getServerStatus());
    } else {
        io.emit('sincronizacionCompleta', payload);
        io.emit('estadoServidor', getServerStatus());
    }
    return payload;
}

client.on('ready', async () => {
    console.log(`Bot encendido: ${client.user.tag}`);
    console.log(`Servidor Web escuchando en el puerto ${process.env.PORT || 3000}`);
    await getDbChannel();
    const status = getServerStatus();
    if (!status.dbChannel) {
        console.warn('Discord: DB_CHANNEL_ID no válido o canal no accesible. Revise .env');
    }
    io.emit('estadoServidor', status);
    emitFullSync().catch((err) => console.error('Error en sincronización inicial:', err.message));
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!registrar')) {
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
        emitFullSync().catch(() => {});
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

    socket.on('intentarLogin', (payload, callback) => {
        callback?.(authenticateUser(payload?.user, payload?.pass));
    });

    socket.on('cerrarSesion', (payload) => {
        const token = payload?.token;
        if (token) activeSessions.delete(token);
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

        await emitFullSync();
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
});

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