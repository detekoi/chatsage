// test-tmi.js
const tmi = require('tmi.js'); // Make sure tmi.js is installed (npm install tmi.js)

const client = new tmi.Client({
    options: { debug: true }, // Enable tmi.js debugging
    identity: {
        username: 'StreamSageTheBot', // Your bot username
        password: 'oauth:08edjlp3x99525itvop6bc9vno4aul' // Paste the FULL oauth: token here
    },
    channels: [ '#parfaitfair' ] // Channel to join and test
});

client.connect().catch(console.error);

client.on('connected', (addr, port) => {
    console.log(`* Connected to <span class="math-inline">\{addr\}\:</span>{port}`);
    // Wait 5 seconds then try to send
    setTimeout(() => {
        const testMessage = `Minimal TMI Test - ${new Date().toLocaleTimeString()}`;
        console.log(`Attempting to send: ${testMessage}`);
        client.say('#parfaittest', testMessage)
            .then((data) => {
                // data[0] usually contains the channel name on successful send confirmation from tmi.js
                console.log(`Send successful (tmi.js confirmation): ${data}`);
            })
            .catch((err) => {
                console.error(`Send failed: ${err}`);
            });
    }, 5000);
});

client.on('message', (channel, tags, message, self) => {
    // Optional: log received messages to confirm connection is live
    // console.log(`${tags['display-name']}: ${message}`);
});

client.on('error', (error) => {
    console.error(`TMI Client Error: ${error}`);
});

client.on('notice', (channel, msgid, message) => {
    console.warn(`TMI Server Notice: Channel: ${channel}, ID: ${msgid}, Msg: ${message}`);
});