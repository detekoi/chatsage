// scripts/probe-animated-emotes.js
import fetch from 'node-fetch';

async function probe() {
    const testIds = [
        'emotesv2_b540f2ee850e419b884ecb03b41e39a3',
        'emotesv2_dc6e649f390041f0b09320e8d0525d8a',
        'emotesv2_e38ecfb9ce4b478385bb12b6f17e3352',
        'emotesv2_108a798544f849b28a2a9042bbf06bc4',
        'emotesv2_1e4bb2e680a647d69f9848529367d307',
        'emotesv2_1a5563853fb34b67b1403063f2780e0c',
        'emotesv2_470d032049d54eecb8fcf61f43a9f0db',
        'emotesv2_4d547f8976b7440498a44b547849e7b2',
        'emotesv2_d5d1c3b1713045618eb7813a4efb3b19',
        '25', '28087', '425618', '88', '86', '58765', '81274', '112290'
    ];

    console.log('Probing Twitch CDN for animated emotes...');
    const found = [];
    for (const id of testIds) {
        try {
            const url = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/animated/dark/3.0`;
            const res = await fetch(url, { method: 'HEAD' });
            if (res.ok) {
                console.log(`✅ FOUND ANIMATED EMOTE: ${id} (${res.headers.get('content-type')}, ${res.headers.get('content-length')} bytes)`);
                found.push(id);
            } else {
                console.log(`❌ ${id}: ${res.status}`);
            }
        } catch (e) {
            console.log(`❌ ${id}: ${e.message}`);
        }
    }
    console.log(`Found ${found.length} working animated emotes:`, found);
}

probe();
