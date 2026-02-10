const { Client, IntentsBitField, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

// ============================================
// CONFIG
// ============================================
let BOT_PASSWORD = generatePassword(); // Initial password
let lastPasswordChange = Date.now();
const PASSWORD_CHANGE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1470711974206771210';
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID || '1026450528575684709';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const GUILD_ID = process.env.GUILD_ID || 'YOUR_GUILD_ID';

// Validate required env vars
if (!DISCORD_TOKEN) {
    console.error('❌ Error: DISCORD_TOKEN not found in environment variables. Set it in Replit secrets.');
    process.exit(1);
}
if (!CLIENT_ID) {
    console.error('❌ Error: CLIENT_ID not found in environment variables. Set it in Replit secrets.');
    process.exit(1);
}

// Data storage
const DATA_DIR = path.join(__dirname, '..', 'data');
const LINKED_FILE = path.join(DATA_DIR, 'linked.json');
let linkedAccounts = {}; // discordId -> { userId, username }
let linkCodes = {}; // discordId -> code

function loadLinkedAccounts() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(LINKED_FILE)) {
            const raw = fs.readFileSync(LINKED_FILE, 'utf8');
            linkedAccounts = JSON.parse(raw) || {};
        }
    } catch (err) {
        console.error('Error loading linked accounts:', err);
        linkedAccounts = {};
    }
}

function saveLinkedAccounts() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(LINKED_FILE, JSON.stringify(linkedAccounts, null, 2), 'utf8');
    } catch (err) {
        console.error('Error saving linked accounts:', err);
    }
}

function generateLinkCodeForUser(discordId) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    linkCodes[discordId] = code;
    return code;
}

async function verifyLinkForUser(discordId, username) {
    try {
        const userId = await getRobloxUserId(username);
        if (!userId) return { success: false, reason: 'Roblox user not found' };

        const info = await getRobloxUserInfo(userId);
        const bio = info && (info.description || info.about || '');
        const code = linkCodes[discordId];
        if (!code) return { success: false, reason: 'No pending link code. Run /link first.' };

        if (!bio || !bio.includes(code)) return { success: false, reason: 'Link code not found in Roblox bio.' };

        // Save link
        linkedAccounts[discordId] = { userId, username };
        delete linkCodes[discordId];
        saveLinkedAccounts();
        return { success: true, userId, username };
    } catch (err) {
        console.error('Error verifying link:', err);
        return { success: false, reason: 'Verification error' };
    }
}

/**
 * Generate a random password
 * @returns {string} Random password (8 characters)
 */
function generatePassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

/**
 * Helper to create a simple embed
 * @param {string} title
 * @param {string} description
 * @param {number} color
 */
function makeEmbed(title, description, color = 0x0099ff) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

/**
 * Robust fetch with retries, backoff and timeout
 * Returns parsed JSON on success or throws an error
 */
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 500, timeout = 8000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(id);

            // Try to parse JSON even on non-OK to capture error details
            let body = null;
            try { body = await resp.clone().json(); } catch (e) { /* ignore json parse */ }

            if (resp.ok) {
                // return parsed JSON if possible
                try { return body !== null ? body : await resp.json(); } catch (e) { return null; }
            }

            // Handle rate limit or server errors with retry
            if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
                const wait = backoff * Math.pow(2, attempt);
                console.warn(`Fetch attempt ${attempt + 1} to ${url} returned ${resp.status}. Retrying in ${wait}ms.`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            // Non-retriable error
            const msg = `HTTP ${resp.status} for ${url} - ${JSON.stringify(body)}`;
            throw new Error(msg);
        } catch (err) {
            clearTimeout(id);
            if (err.name === 'AbortError') {
                if (attempt < retries) {
                    const wait = backoff * Math.pow(2, attempt);
                    console.warn(`Fetch to ${url} timed out. Retrying in ${wait}ms.`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw new Error(`Timeout fetching ${url}`);
            }

            if (attempt < retries) {
                const wait = backoff * Math.pow(2, attempt);
                console.warn(`Fetch error (attempt ${attempt + 1}) to ${url}: ${err.message}. Retrying in ${wait}ms.`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            throw err;
        }
    }
}

/**
 * Schedule password rotation every 7 days
 */
function schedulePasswordRotation() {
    setInterval(async () => {
        const oldPassword = BOT_PASSWORD;
        BOT_PASSWORD = generatePassword();
        lastPasswordChange = Date.now();
        
            console.log(`✅ Password auto-rotated. New password: ${BOT_PASSWORD}`);
        
            // Send notification to channel (automatic rotation)
            try {
                const channel = await client.channels.fetch(NOTIFICATION_CHANNEL_ID);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setTitle('Password Auto-Rotated')
                        .addFields(
                            { name: 'Old Password', value: `\`${oldPassword}\`` , inline: true },
                            { name: 'New Password', value: `\`${BOT_PASSWORD}\`` , inline: true },
                            { name: 'Changed By', value: 'Automatic rotation', inline: false }
                        )
                        .setColor(0xffa500)
                        .setTimestamp();
                    await channel.send({ embeds: [embed] });
                }
            } catch (error) {
                console.error('Error sending notification:', error);
            }
    }, PASSWORD_CHANGE_INTERVAL);
}

// ============================================
// ROBLOX PLAYER VALIDATION FUNCTIONS
// ============================================

/**
 * Get Roblox user ID by username
 * @param {string} username - Roblox username
 * @returns {Promise<number|null>} User ID or null if not found
 */
async function getRobloxUserId(username) {
    try {
        const url = `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username)}`;
        const data = await fetchWithRetry(url);
        if (data && data.data && data.data.length > 0) return data.data[0].id;
        return null;
    } catch (error) {
        console.error('Error fetching Roblox user ID:', error);
        return null;
    }
}

/**
 * Get Roblox user info including account creation date
 * @param {number} userId - Roblox user ID
 * @returns {Promise<object|null>} User info object or null
 */
async function getRobloxUserInfo(userId) {
    try {
        const url = `https://users.roblox.com/v1/users/${userId}`;
        const data = await fetchWithRetry(url);
        return data || null;
    } catch (error) {
        console.error('Error fetching user info:', error);
        return null;
    }
}

/**
 * Get Roblox badges count - counts all badges earned by user
 * @param {number} userId - Roblox user ID
 * @returns {Promise<number>} Number of badges
 */
async function getRobloxBadgesCount(userId) {
    try {
        let totalBadges = 0;
        let cursor = '';
        
        // Paginate through all badges
        while (true) {
            const url = `https://badges.roblox.com/v1/users/${userId}/badges?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
            const data = await fetchWithRetry(url);

            if (!data || !data.data || data.data.length === 0) break;

            totalBadges += data.data.length;

            // Check if there are more pages
            if (!data.nextPageCursor) break;
            cursor = data.nextPageCursor;
        }
        
        return totalBadges;
    } catch (error) {
        console.error('Error fetching badges:', error);
        return 0;
    }
}

/**
 * Get Roblox friends count
 * @param {number} userId - Roblox user ID
 * @returns {Promise<number>} Number of friends
 */
async function getRobloxFriendsCount(userId) {
    try {
        const url = `https://friends.roblox.com/v1/users/${userId}/friends/count`;
        const data = await fetchWithRetry(url);
        return (data && typeof data.count === 'number') ? data.count : 0;
    } catch (error) {
        console.error('Error fetching friends count:', error);
        return 0;
    }
}

/**
 * Get a Roblox avatar image URL for a user
 * @param {number} userId
 * @returns {Promise<string|null>} image URL or null
 */
async function getRobloxAvatarUrl(userId) {
    try {
        const url = `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=png&isCircular=false`;
        const data = await fetchWithRetry(url);
        if (data && data.data && data.data.length > 0) {
            return data.data[0].imageUrl || null;
        }
        return null;
    } catch (err) {
        console.error('Error fetching avatar thumbnail:', err);
        return null;
    }
}

/* Group rank checks removed */

/**
 * Check account age in months
 * @param {string} createdDate - ISO date string from Roblox API
 * @returns {number} Age in months
 */
function getAccountAgeInMonths(createdDate) {
    const accountCreated = new Date(createdDate);
    const now = new Date();
    
    let months = (now.getFullYear() - accountCreated.getFullYear()) * 12;
    months += now.getMonth() - accountCreated.getMonth();
    
    return months;
}

/**
 * Validate if Roblox player meets requirements
 * Requirements: 200+ badges, 2+ months account age, and 30+ friends
 * @param {string} username - Roblox username
 * @returns {Promise<object>} Validation result
 */
async function validateRobloxPlayer(username) {
    const result = {
        username,
        isValid: false,
        badges: 0,
        accountAge: 0,
        friends: 0,
        badgesValid: false,
        accountAgeValid: false,
        friendsValid: false,
        errors: []
    };

    try {
        // Get user ID
        const userId = await getRobloxUserId(username);
        if (!userId) {
            result.errors.push('Player not found');
            return result;
        }

        // Get badges count, friends count and user info in parallel
        const [badgesCount, friendsCount, userInfo] = await Promise.all([
            getRobloxBadgesCount(userId),
            getRobloxFriendsCount(userId),
            getRobloxUserInfo(userId)
        ]);

        result.badges = badgesCount;
        result.badgesValid = badgesCount >= 200;

        result.friends = friendsCount;
        result.friendsValid = friendsCount >= 30;


        if (userInfo && userInfo.created) {
            const accountAge = getAccountAgeInMonths(userInfo.created);
            result.accountAge = accountAge;
            result.accountAgeValid = accountAge >= 2;
        } else {
            result.errors.push('Could not fetch account creation date');
        }

        // Overall validation
        result.isValid = result.badgesValid && result.accountAgeValid && result.friendsValid;
        
        return result;
    } catch (error) {
        result.errors.push(`Validation error: ${error.message}`);
        return result;
    }
}

client.on('ready', () => {
    console.log(`${client.user.username} is online!`);
    console.log(`🔐 Current Password: ${BOT_PASSWORD}`);
    registerSlashCommands();
    schedulePasswordRotation();
});
// Load linked accounts after defining handlers
loadLinkedAccounts();

/**
 * Register slash commands with Discord
 */
async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('check')
            .setDescription('Validate a Roblox player')
            .addStringOption(option =>
                option
                    .setName('password')
                    .setDescription('Authentication password (omit if you linked your account)')
                    .setRequired(false)
            )
            .addStringOption(option =>
                option
                    .setName('username')
                    .setDescription('Roblox username to check (omit to use linked account)')
                    .setRequired(false)
            ),
        new SlashCommandBuilder()
            .setName('link')
            .setDescription('Begin linking your Roblox account (generates a bio code)'),
        new SlashCommandBuilder()
            .setName('verify')
            .setDescription('Verify your Roblox bio contains the link code')
            .addStringOption(option =>
                option
                    .setName('username')
                    .setDescription('Roblox username to verify')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('unlink')
            .setDescription('Unlink your Roblox account'),
        new SlashCommandBuilder()
            .setName('changepassword')
            .setDescription('Change the validation password (Admin only)')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        console.log('Registering slash commands...');

        // If a GUILD_ID is provided, register commands to that guild (instant).
        // Otherwise register global commands (can take up to 1 hour to propagate).
        if (GUILD_ID && GUILD_ID !== 'YOUR_GUILD_ID') {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
                { body: commands }
            );
            console.log('Slash commands registered for guild:', GUILD_ID);
        } else {
            await rest.put(
                Routes.applicationCommands(CLIENT_ID),
                { body: commands }
            );
            console.log('Global slash commands registered (may take up to 1 hour to appear).');
        }
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'check') {
        const password = interaction.options.getString('password');
        const username = interaction.options.getString('username');
        const executorId = interaction.user.id;
        const linked = linkedAccounts[executorId];

        // Username is required
        if (!username) {
            const embed = makeEmbed('Missing Username', 'You must provide a Roblox `username` to check.', 0xff0000);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        // Check access: either password OR linked account required
        const hasPassword = password && password === BOT_PASSWORD;
        const isLinked = linked !== undefined;

        if (!hasPassword && !isLinked) {
            const embed = makeEmbed('Access Denied', 'You need either the password or a linked account to use this command. Link your account with `/link` and `/verify`.', 0xff0000);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        if (password && !hasPassword) {
            const embed = makeEmbed('Invalid Password', 'The password you provided is incorrect.', 0xff0000);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        await interaction.deferReply();
        const validation = await validateRobloxPlayer(username);

        if (validation.errors.length > 0) {
            const embed = makeEmbed('Error', validation.errors.join('\n'), 0xff0000);
            await interaction.editReply({ embeds: [embed] });
            return;
        }

        const badgeStatus = validation.badgesValid ? '✅' : '❌';
        const ageStatus = validation.accountAgeValid ? '✅' : '❌';
        const friendsStatus = validation.friendsValid ? '✅' : '❌';
        const overallStatus = validation.isValid ? '✅ VALID' : '❌ INVALID';

        // Try to fetch avatar image for embed
        let avatarUrl = null;
        try {
            const userId = await getRobloxUserId(username);
            if (userId) avatarUrl = await getRobloxAvatarUrl(userId);
        } catch (err) {
            console.warn('Could not fetch avatar for', username, err.message);
        }

        const embed = new EmbedBuilder()
            .setTitle(`Validation Results — ${username}`)
            .addFields(
                { name: 'Badges', value: `${validation.badges}/200 ${badgeStatus}`, inline: true },
                { name: 'Account Age', value: `${validation.accountAge} months ${ageStatus}`, inline: true },
                { name: 'Friends', value: `${validation.friends}/30 ${friendsStatus}`, inline: true },
                { name: 'Overall', value: `${overallStatus}`, inline: false }
            )
            .setColor(validation.isValid ? 0x00ff00 : 0xff0000)
            .setTimestamp();

        if (avatarUrl) {
            // set image (large) and thumbnail
            embed.setImage(avatarUrl);
            embed.setThumbnail(avatarUrl);
        }

        await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'link') {
        // Generate a link code and instruct the user to put it in their Roblox bio
        const discordId = interaction.user.id;
        const code = generateLinkCodeForUser(discordId);
        const embed = new EmbedBuilder()
            .setTitle('Link Your Roblox Account')
            .setDescription(`Place the following code in your Roblox profile 'About' / bio, then run /verify <username> to complete linking.`)
            .addFields(
                { name: 'Link Code', value: `\`${code}\``, inline: false },
                { name: 'Instructions', value: 'Put the code in your Roblox profile About/Bio and then run `/verify <username>` here.', inline: false }
            )
            .setColor(0x0099ff)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }

    if (interaction.commandName === 'verify') {
        const username = interaction.options.getString('username');
        await interaction.deferReply({ ephemeral: true });
        const res = await verifyLinkForUser(interaction.user.id, username);
        if (!res.success) {
            const embed = makeEmbed('Verification Failed', res.reason, 0xff0000);
            await interaction.editReply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Account Linked')
            .setDescription(`Successfully linked Roblox account **${res.username}** to your Discord account.`)
            .addFields(
                { name: 'Roblox Username', value: `${res.username}`, inline: true },
                { name: 'Roblox ID', value: `${res.userId}`, inline: true }
            )
            .setColor(0x00cc99)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    if (interaction.commandName === 'unlink') {
        const discordId = interaction.user.id;
        if (!linkedAccounts[discordId]) {
            const embed = makeEmbed('Not Linked', 'You do not have a linked Roblox account.', 0xff0000);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
        delete linkedAccounts[discordId];
        saveLinkedAccounts();
        const embed = makeEmbed('Unlinked', 'Your Roblox account has been unlinked.', 0x00cc99);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }

    if (interaction.commandName === 'changepassword') {
        // Check if user is authorized
        if (interaction.user.id !== AUTHORIZED_USER_ID) {
            const embed = makeEmbed('Unauthorized', 'You are not authorized to use this command.', 0xff0000);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        const oldPassword = BOT_PASSWORD;
        BOT_PASSWORD = generatePassword();
        lastPasswordChange = Date.now();
        
        console.log(`✅ Password changed by ${interaction.user.id}. New password: ${BOT_PASSWORD}`);
        
        // Send confirmation to the executing user (ephemeral) and include who changed it
        const embed = new EmbedBuilder()
            .setTitle('Password Changed')
            .addFields(
                { name: 'Old Password', value: `\`${oldPassword}\``, inline: true },
                { name: 'New Password', value: `\`${BOT_PASSWORD}\``, inline: true },
                { name: 'Changed By', value: `<@${interaction.user.id}>`, inline: false }
            )
            .setColor(0x00cc99)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        
        // Send notification to notification channel (manual change)
        try {
            const channel = await client.channels.fetch(NOTIFICATION_CHANNEL_ID);
            if (channel) {
                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }
});

client.on('messageCreate', (msg) => {

    if (msg.content === 'hey') {
        const embed = makeEmbed('Hello!', 'Hello!');
        msg.reply({ embeds: [embed] });
    }
});

client.login(DISCORD_TOKEN);