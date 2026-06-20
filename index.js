require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

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

function getDbChannel() {
    return client.channels.cache.get(DB_CHANNEL_ID) || null;
}

async function fetchRecordsFromDiscord(filterFn) {
    const dbChannel = getDbChannel();
    if (!dbChannel) return [];

    const messages = await dbChannel.messages.fetch({ limit: FETCH_LIMIT });
    const list = [];
    const seenIds = new Set();

    messages.forEach((msg) => {
        if (msg.author.id !== client.user.id) return;
        const record = parseRecordMessage(msg.content);
        if (!record?.id || !filterFn(record) || seenIds.has(String(record.id))) return;
        seenIds.add(String(record.id));
        list.push(record);
    });

    return list.reverse();
}

async function fetchAthletesFromDiscord() {
    return fetchRecordsFromDiscord((record) => !isJudgeRecord(record));
}

async function fetchJudgesFromDiscord() {
    return fetchRecordsFromDiscord(isJudgeRecord);
}

async function findRecordMessage(athleteId, filterFn) {
    const dbChannel = getDbChannel();
    if (!dbChannel) return null;

    const messages = await dbChannel.messages.fetch({ limit: FETCH_LIMIT });
    for (const msg of messages.values()) {
        if (msg.author.id !== client.user.id) continue;
        const record = parseRecordMessage(msg.content);
        if (record && String(record.id) === String(athleteId) && filterFn(record)) {
            return { message: msg, record };
        }
    }
    return null;
}

async function findAthleteMessage(athleteId) {
    return findRecordMessage(athleteId, (record) => !isJudgeRecord(record));
}

async function findJudgeMessage(judgeId) {
    return findRecordMessage(judgeId, isJudgeRecord);
}

async function emitAthletesList(targetSocket) {
    const list = await fetchAthletesFromDiscord();
    if (targetSocket) targetSocket.emit('cargarAtletas', list);
    else io.emit('cargarAtletas', list);
    return list;
}

async function emitJudgesList(targetSocket) {
    const list = await fetchJudgesFromDiscord();
    if (targetSocket) targetSocket.emit('cargarJueces', list);
    else io.emit('cargarJueces', list);
    return list;
}

client.on('ready', () => {
    console.log(`Bot encendido: ${client.user.tag}`);
    console.log(`Servidor Web escuchando en el puerto ${process.env.PORT || 3000}`);
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

        const dbChannel = getDbChannel();
        if (!dbChannel) {
            return message.reply('Error: No encuentro el canal de la Base de Datos.');
        }

        await dbChannel.send(formatAthleteMessage(newAthlete));
        message.reply(`Atleta **${args[0]}** guardado correctamente.`);
        io.emit('nuevoAtleta', newAthlete);
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
    if (isJudgeRecord(record)) io.emit('juezEliminado', { id: record.id });
    else io.emit('atletaEliminado', { id: record.id });
});

io.on('connection', async (socket) => {
    console.log('Nueva conexión desde la Mesa de Control Web');
    await emitAthletesList(socket);
    await emitJudgesList(socket);

    socket.on('solicitarAtletas', async () => {
        await emitAthletesList(socket);
    });

    socket.on('solicitarJueces', async () => {
        await emitJudgesList(socket);
    });

    socket.on('registrarDesdeWeb', async (athleteData) => {
        const dbChannel = getDbChannel();
        if (!dbChannel || !athleteData?.id) return;

        const existing = await findAthleteMessage(athleteData.id);
        if (existing) {
            await existing.message.edit(formatAthleteMessage(athleteData));
            io.emit('atletaActualizado', athleteData);
            return;
        }

        await dbChannel.send(formatAthleteMessage(athleteData));
        io.emit('nuevoAtleta', athleteData);
    });

    socket.on('editarDesdeWeb', async (athleteData) => {
        if (!athleteData?.id) return;

        const found = await findAthleteMessage(athleteData.id);
        if (found) {
            await found.message.edit(formatAthleteMessage(athleteData));
            io.emit('atletaActualizado', athleteData);
            return;
        }

        const dbChannel = getDbChannel();
        if (!dbChannel) return;
        await dbChannel.send(formatAthleteMessage(athleteData));
        io.emit('nuevoAtleta', athleteData);
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
        const dbChannel = getDbChannel();
        if (!dbChannel) return;

        const messages = await dbChannel.messages.fetch({ limit: FETCH_LIMIT });
        for (const msg of messages.values()) {
            if (msg.author.id !== client.user.id) continue;
            const record = parseRecordMessage(msg.content);
            if (!record || isJudgeRecord(record)) continue;
            await msg.delete().catch(() => {});
        }

        io.emit('cargarAtletas', []);
    });

    socket.on('registrarJuezDesdeWeb', async (judgeData) => {
        const dbChannel = getDbChannel();
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

        const dbChannel = getDbChannel();
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

    socket.on('reordenarJuecesDesdeWeb', async (payload) => {
        const items = payload?.judges || payload || [];
        if (!Array.isArray(items) || items.length === 0) return;

        for (const item of items) {
            if (!item?.id) continue;
            const found = await findJudgeMessage(item.id);
            if (!found) continue;
            const updated = { ...found.record, sortOrder: item.sortOrder };
            await found.message.edit(formatJudgeMessage(updated));
        }

        const list = await fetchJudgesFromDiscord();
        io.emit('juecesReordenados', list);
    });
});

client.login(process.env.DISCORD_TOKEN);
server.listen(process.env.PORT || 3000);