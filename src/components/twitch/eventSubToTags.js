// src/components/twitch/eventSubToTags.js
// Converts EventSub channel.chat.message event data to IRC-style tags
// for compatibility with existing command processor and message handlers

import logger from '../../lib/logger.js';

/**
 * Converts EventSub channel.chat.message event to IRC-style tags
 * @param {object} event - EventSub channel.chat.message event object
 * @returns {object} IRC-style tags object compatible with commandProcessor
 */
export function convertEventSubToTags(event) {
    const tags = {
        // User identification
        username: event.chatter_user_login?.toLowerCase(),
        'display-name': event.chatter_user_name,
        'user-id': event.chatter_user_id,

        // Message identification
        id: event.message_id,
        'message-id': event.message_id,

        // Color
        color: event.color || null,

        // Badges - convert EventSub badges array to IRC badge format
        badges: {},
        'badge-info': {},

        // Moderator flag (derived from badges)
        mod: false,

        // Subscriber flag (derived from badges)
        subscriber: false,

        // VIP flag (derived from badges)
        vip: false,

        // Bits/cheer
        bits: null,

        // Message type
        'message-type': event.message_type || 'chat',

        // Raw EventSub fragments for emote processing
        fragments: event?.message?.fragments || null,
    };

    // Process badges
    if (event.badges && Array.isArray(event.badges)) {
        for (const badge of event.badges) {
            const setId = badge.set_id;
            const id = badge.id;
            const info = badge.info || '';

            // Add to badges object in IRC format
            tags.badges[setId] = id;

            // Add to badge-info if there's info
            if (info) {
                tags['badge-info'][setId] = info;
            }

            // Set flags based on badge types
            if (setId === 'moderator') {
                tags.mod = true;
            } else if (setId === 'subscriber') {
                tags.subscriber = true;
            } else if (setId === 'vip') {
                tags.vip = true;
            } else if (setId === 'broadcaster') {
                // Broadcaster is always a moderator
                tags.mod = true;
                tags.badges.broadcaster = '1';
            }
        }
    }

    // Process cheer/bits
    if (event.cheer) {
        tags.bits = event.cheer.bits?.toString() || '0';
    }

    // Add reply information if present
    if (event.reply) {
        tags['reply-parent-msg-id'] = event.reply.parent_message_id;
        tags['reply-parent-user-id'] = event.reply.parent_user_id;
        tags['reply-parent-user-login'] = event.reply.parent_user_login;
        tags['reply-parent-display-name'] = event.reply.parent_user_name;
        tags['reply-parent-msg-body'] = event.reply.parent_message_body;
    }

    // Add channel points custom reward ID if present
    if (event.channel_points_custom_reward_id) {
        tags['custom-reward-id'] = event.channel_points_custom_reward_id;
    }

    logger.debug({
        username: tags.username,
        badges: tags.badges,
        mod: tags.mod,
        subscriber: tags.subscriber,
        bits: tags.bits
    }, 'Converted EventSub event to tags');

    return tags;
}
