// scripts/probe-7tv-and-twitch.js
import fetch from 'node-fetch';

async function probe() {
    console.log('--- 1. Fetching 7TV Global Emotes ---');
    try {
        const res = await fetch('https://7tv.io/v3/emote-sets/global');
        if (res.ok) {
            const data = await res.json();
            const animated = data.emotes.filter(e => e.data?.animated);
            const staticEmotes = data.emotes.filter(e => !e.data?.animated);
            console.log(`7TV Global Emotes found: Total=${data.emotes.length}, Animated=${animated.length}, Static=${staticEmotes.length}`);
            console.log('Sample Animated 7TV Emotes:');
            animated.slice(0, 10).forEach(e => {
                const host = e.data.host.url;
                const file = e.data.host.files.find(f => f.name.endsWith('.webp') || f.name.endsWith('.gif')) || e.data.host.files[0];
                console.log(`  - ${e.name} (ID: ${e.id}): https:${host}/${file.name}`);
            });
        }
    } catch (e) {
        console.error('7TV fetch failed:', e.message);
    }

    console.log('\n--- 2. Checking Twitch Static Global Emotes ---');
    const twitchStaticIds = [
        { id: '25', name: 'Kappa' },
        { id: '425618', name: 'LUL' },
        { id: '28087', name: 'WutFace' },
        { id: '88', name: 'PogChamp' },
        { id: '86', name: 'BibleThump' },
        { id: '58765', name: 'NotLikeThis' },
        { id: '81274', name: 'VoHiYo' }
    ];

    for (const item of twitchStaticIds) {
        const url = `https://static-cdn.jtvnw.net/emoticons/v2/${item.id}/static/dark/3.0`;
        const res = await fetch(url);
        console.log(`Twitch Static ${item.name} (${item.id}): Status=${res.status}, Type=${res.headers.get('content-type')}`);
    }
}

probe();
