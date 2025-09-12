import { getChannelAutoChatConfig, saveChannelAutoChatConfig, normalizeConfig } from '../../context/autoChatStorage.js';

const helpText = 'Usage: !auto [off|low|medium|high] or !auto-config greetings:[on|off] facts:[on|off] questions:[on|off] ads:[on|off]';

async function execute({ channel, _user, args, logger: log }) {
    const channelName = channel.substring(1);
    // Permission checking is handled by the command system

    const sub = (args[0] || '').toLowerCase();
    if (!sub) {
        const cfg = await getChannelAutoChatConfig(channelName);
        log.info({ channelName, cfg }, '[!auto] Current auto-chat config');
        const cats = cfg.categories;
        const parts = [`mode=${cfg.mode}`, `cats=${['greetings','facts','questions','ads'].filter(k => cats[k]).join('+') || 'none'}`];
        return this.reply(channel, `Auto-chat: ${parts.join(', ')}. ${helpText}`);
    }

    if (['off','low','medium','high'].includes(sub)) {
        const cfg = await getChannelAutoChatConfig(channelName);
        cfg.mode = sub;
        await saveChannelAutoChatConfig(channelName, cfg);
        return this.reply(channel, `Auto-chat mode set to ${sub}.`);
    }

    if (sub === 'config' || sub === 'auto-config') {
        // Parse key:value pairs
        const kvs = args.slice(1).map(s => s.trim()).filter(Boolean);
        const cfg = await getChannelAutoChatConfig(channelName);
        for (const kv of kvs) {
            const [k, vRaw] = kv.split(':');
            const key = (k || '').toLowerCase();
            const v = (vRaw || '').toLowerCase();
            if (['greetings','facts','questions','ads'].includes(key)) {
                cfg.categories[key] = (v === 'on' || v === 'true' || v === 'yes' || v === '1');
            }
        }
        const clean = normalizeConfig(cfg);
        await saveChannelAutoChatConfig(channelName, clean);
        const cats = clean.categories;
        return this.reply(channel, `Updated auto-chat: mode=${clean.mode}, cats=${['greetings','facts','questions','ads'].filter(k => cats[k]).join('+') || 'none'}`);
    }

    return this.reply(channel, helpText);
}

async function reply(channel, message) {
    const { enqueueMessage } = await import('../../../lib/ircSender.js');
    await enqueueMessage(channel, message);
}

export default {
    execute,
    reply,
    permission: 'moderator',
    description: 'Configure auto-chat mode and options.'
};