require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1. CONFIGURACIÓN DEL SERVIDOR WEB (Para la página web)
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } // Permite que cualquier web se conecte
});

// 2. CONFIGURACIÓN DE DISCORD
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID;

client.on('ready', () => {
    console.log(`🤖 Bot encendido: ${client.user.tag}`);
    console.log(`📡 Servidor Web escuchando en el puerto ${process.env.PORT || 3000}`);
});

// 3. ESCUCHAR COMANDOS DESDE DISCORD (!registrar)
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!registrar')) {
        const args = message.content.replace('!registrar', '').split('|').map(s => s.trim());
        
        if (args.length < 4) {
            return message.reply('⚠️ Formato: `!registrar Nombre Completo | Cédula | Modalidad | Categoría`');
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

        const dbChannel = client.channels.cache.get(DB_CHANNEL_ID);
        if (dbChannel) {
            // Guardar en la "bóveda" de Discord
            await dbChannel.send(`\`\`\`json\n${JSON.stringify(newAthlete)}\n\`\`\``);
            message.reply(`✅ Atleta **${args[0]}** guardado correctamente.`);
            
            // Avisar a la página web
            io.emit('nuevoAtleta', newAthlete);
        } else {
            message.reply('❌ Error: No encuentro el canal de la Base de Datos.');
        }
    }
});

// 4. ESCUCHAR CONEXIONES DESDE LA PÁGINA WEB
io.on('connection', async (socket) => {
    console.log('🌐 Nueva conexión desde la Mesa de Control Web');

    const dbChannel = client.channels.cache.get(DB_CHANNEL_ID);
    
    // A. Enviar el historial a la web al entrar
    if (dbChannel) {
        try {
            const messages = await dbChannel.messages.fetch({ limit: 100 });
            const athletesList = [];
            
            messages.forEach(msg => {
                if (msg.author.id === client.user.id && msg.content.startsWith('```json')) {
                    const jsonString = msg.content.replace('```json\n', '').replace('\n```', '');
                    try { athletesList.push(JSON.parse(jsonString)); } catch(e){}
                }
            });
            socket.emit('cargarAtletas', athletesList.reverse());
        } catch (error) {
            console.error("Error leyendo historial:", error);
        }
    }

    // B. Recibir formulario desde la web y guardarlo en Discord
    socket.on('registrarDesdeWeb', async (athleteData) => {
        if (dbChannel) {
            // Guardar en Discord
            await dbChannel.send(`\`\`\`json\n${JSON.stringify(athleteData)}\n\`\`\``);
            
            // Re-transmitir a todas las demás pantallas web conectadas
            io.emit('nuevoAtleta', athleteData);
            
            // Opcional: Avisar en un canal público que la web registró a alguien
            // const canalPublico = client.channels.cache.get('ID_CANAL_PUBLICO');
            // canalPublico.send(`💻 Nuevo registro desde la Web: **${athleteData.fullName}**`);
        }
    });
});

client.login(process.env.DISCORD_TOKEN);
server.listen(process.env.PORT || 3000);
