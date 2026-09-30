import { getChannelAutoChatConfig, saveChannelAutoChatConfig, normalizeConfig } from '../../context/autoChatStorage.js';
import { sendLocalized, localize } from '../../../lib/localizedMessage.js';

const helpText = 'Usage: !auto [off|low|medium|high] or !auto config greetings:<on|off> facts:<on|off> questions:<on|off> follows:<on|off> subscriptions:<on|off> raids:<on|off> ads:<on|off>';

const ALL_CATEGORIES = ['greetings', 'facts', 'questions', 'follows', 'subscriptions', 'raids', 'ads'];

async function execute({ channel, _user, args, logger: log }) {
    const channelName = channel.substring(1);
    // Permission checking is handled by the command system

    const sub = (args[0] || '').toLowerCase();
    if (!sub) {
        const cfg = await getChannelAutoChatConfig(channelName);
        log.info({ channelName, cfg }, '[!auto] Current auto-chat config');
        const cats = cfg.categories;
        const parts = [`mode=${cfg.mode}`, `cats=${ALL_CATEGORIES.filter(k => cats[k]).join('+') || 'none'}`];
        const settings = parts.join(', ');
        // The usage line is itself catalogued, so localize it before embedding it in the status line.
        const usage = localize(channel, 'usage.auto.Help', {}, helpText).text;
        return sendLocalized(channel, 'cmd.auto.Status', { settings, usage }, `Auto-chat: ${settings}. ${helpText}`);
    }

    if (['off','low','medium','high'].includes(sub)) {
        const cfg = await getChannelAutoChatConfig(channelName);
        cfg.mode = sub;
        await saveChannelAutoChatConfig(channelName, cfg);
        return sendLocalized(channel, 'cmd.auto.ModeSet', { mode: sub }, `Auto-chat mode set to ${sub}.`);
    }

    if (sub === 'config' || sub === 'auto-config') {
        // Parse key:value pairs
        const kvs = args.slice(1).map(s => s.trim()).filter(Boolean);
        const cfg = await getChannelAutoChatConfig(channelName);
        for (const kv of kvs) {
            const [k, vRaw] = kv.split(':');
            const key = (k || '').toLowerCase();
            const v = (vRaw || '').toLowerCase();
            if (ALL_CATEGORIES.includes(key)) {
                cfg.categories[key] = (v === 'on' || v === 'true' || v === 'yes' || v === '1');
            }
        }
        const clean = normalizeConfig(cfg);
        await saveChannelAutoChatConfig(channelName, clean);
        const cats = clean.categories;
        const settings = `mode=${clean.mode}, cats=${ALL_CATEGORIES.filter(k => cats[k]).join('+') || 'none'}`;
        return sendLocalized(channel, 'cmd.auto.Updated', { settings }, `Updated auto-chat: ${settings}`);
    }

    return sendLocalized(channel, 'usage.auto.Help', {}, helpText);
}

export default {
    execute,
    permission: 'moderator',
    description: 'Configure auto-chat mode and options.'
};