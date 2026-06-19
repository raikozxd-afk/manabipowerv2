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

function parseAthleteMessage(content) {
    if (!content || !content.startsWith('```json')) return null;
    const jsonString = content.replace('```json\n', '').replace('\n```', '').trim();
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
}

function formatAthleteMessage(athlete) {
    return `\`\`\`json\n${JSON.stringify(athlete)}\n\`\`\``;
}

function getDbChannel() {
    return client.channels.cache.get(DB_CHANNEL_ID) || null;
}

async function fetchAthletesFromDiscord() {
    const dbChannel = getDbChannel();
    if (!dbChannel) return [];

    const messages = await dbChannel.messages.fetch({ limit: FETCH_LIMIT });
    const athletesList = [];
    const seenIds = new Set();

    messages.forEach((msg) => {
        if (msg.author.id !== client.user.id) return;
        const athlete = parseAthleteMessage(msg.content);
        if (!athlete?.id || seenIds.has(String(athlete.id))) return;
        seenIds.add(String(athlete.id));
        athletesList.push(athlete);
    });

    return athletesList.reverse();
}

async function findAthleteMessage(athleteId) {
    const dbChannel = getDbChannel();
    if (!dbChannel) return null;

    const messages = await dbChannel.messages.fetch({ limit: FETCH_LIMIT });
    for (const msg of messages.values()) {
        if (msg.author.id !== client.user.id) continue;
        const athlete = parseAthleteMessage(msg.content);
        if (athlete && String(athlete.id) === String(athleteId)) {
            return { message: msg, athlete };
        }
    }
    return null;
}

async function emitAthletesList(targetSocket) {
    const list = await fetchAthletesFromDiscord();
    if (targetSocket) targetSocket.emit('cargarAtletas', list);
    else io.emit('cargarAtletas', list);
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
        const athleteId = message.content.replace('!eliminar', '').trim();
        if (!athleteId) {
            return message.reply('Formato: `!eliminar ID_DEL_ATLETA`');
        }

        const found = await findAthleteMessage(athleteId);
        if (!found) {
            return message.reply(`No encontré al atleta con ID **${athleteId}**.`);
        }

        await found.message.delete();
        io.emit('atletaEliminado', { id: athleteId });
        return message.reply(`Atleta **${found.athlete.fullName || athleteId}** eliminado.`);
    }
});

client.on('messageDelete', async (message) => {
    if (!message.author || message.author.id !== client.user.id) return;
    const athlete = parseAthleteMessage(message.content);
    if (athlete?.id) {
        io.emit('atletaEliminado', { id: athlete.id });
    }
});

io.on('connection', async (socket) => {
    console.log('Nueva conexión desde la Mesa de Control Web');
    await emitAthletesList(socket);

    socket.on('solicitarAtletas', async () => {
        await emitAthletesList(socket);
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
            if (!msg.content.startsWith('```json')) continue;
            await msg.delete().catch(() => {});
        }

        io.emit('cargarAtletas', []);
    });
});

client.login(process.env.DISCORD_TOKEN);
server.listen(process.env.PORT || 3000);