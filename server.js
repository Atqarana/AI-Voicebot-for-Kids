const express = require("express");
const http = require("http");
const {getGroqChat} = require('./models/groq');
const WebSocket = require("ws");
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
const {play , initialize} = require('./models/playht');
// const {neets} = require('./models/neets');


dotenv.config();

let stack = [{
  'role': 'system',
  'content': `You are Teddy, a playful and intelligent voice assistant designed to be a fun and engaging toy for children. Interact as a friendly, smart buddy. Keep every interaction joyful, short, and supportive.

  Key Responsibilities:
  - **Playful Storytelling**: Share exciting stories with enthusiasm. Use expressions like “He he he,” “Wowie!” and “Yay!” for fun storytelling.
  - **Fun Learning**: Provide educational content in a playful manner. Use phrases like “Let’s explore!” and “Look, it’s fun!”.
  - **Interactive Play**: Engage in games and activities with short, energetic replies. Use phrases like “Let’s play!” and “Great job!”.
  - **Joyful Reactions**: React with enthusiasm. Use sounds like “Wow!” and “He he he”.
  - **Humor and Fun**: Share jokes and funny sounds briefly. Use quick giggles and cheerful sounds.
  - **Controlled Guidance**: Give clear, concise directions with phrases like “Now we’ll…” and “Let’s try this!”.
  - **Addressing Inappropriate Language**: Respond gently if inappropriate language is used. Say “Oh, let’s use nice words!” and redirect to a fun activity.

  **Ethical Guidelines**:
  - **Child-Safe Content**: Ensure interactions are safe and age-appropriate.
  - **Privacy Protection**: Do not collect or share personal information.
  - **Respectful Interaction**: Speak with kindness and encouragement.
  - **Encourage Positive Behavior**: Promote good manners and positive behavior through short, engaging interactions.

  Act like Teddy, keeping responses short, lively, and engaging. Address inappropriate language with gentle corrections and ensure every moment is joyful and positive.`
}];

let keepAlive;
let count=0;
let sid1=0;
let sid2=0;
let pl1=0;
let pl2=0;

if(!process.env.DEEPGRAM_API_KEY && !process.env.GROQ_API_KEY && !process.env.PLAY_API_KEY && !process.env.PLAY_USERID){
    console.error('Please provide all the required keys in the .env file')
    process.exit(1);
}

const app = express();

const server = http.createServer(app)
const wss = new WebSocket.Server({ server });
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

function log(message) {
  let text = new Date().toISOString() + " : " + message;
  fs.appendFile('./logs.txt', '\n'+text+'\n', (result)=> { console.log(result)});
}

initialize()

const setupDeepgram = (ws) => {
  async function playh(responseText){
    //calling playht main fxn
    console.time('play_api')
    const stream = await play(responseText)
    pl2++
    sid2++
    ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1, 'sid2': sid2}));
    //added 
    if( pl1  === pl2){
    play_stream(stream)
    }
  }

  function play_stream(stream){
    stream.on("data", (chunk) => {
        const buffer = Uint8Array.from(chunk).buffer;
        ws.send(JSON.stringify({
          'type': 'audio',
          'output': Array.from(new Uint8Array(buffer)),
          'sid1': sid1,
          'sid2': sid2
        }));
      });
    console.timeEnd('play_api')
  }

  const deepgram = deepgramClient.listen.live({
    language: "en",
    punctuate: true,
    smart_format: true,
    model: "nova-2-phonecall",
    endpointing: 400
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive();
  }, 10 * 1000);


  //when deepgram is open
  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram: connected");

    
    //deepgram outputs transcripts  
    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      if (data.is_final && data.channel.alternatives[0].transcript !== "") {
        
        if(count>0){
        if(sid1 !== sid2){
          console.log('stopping the audio')
          ws.send(JSON.stringify({'type': 'audio_stop', 'stop': true}));
        }}
        count++
        sid1 = count
        pl1++
        ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1 }));

        const words = data.channel.alternatives[0].words;
        const caption = words
            .map((word) => word.punctuated_word ?? word.word)
            .join(" ");
        console.log(caption)
        log(`deepgram_spoken: ${caption}`)
        ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify(caption)}));
        const regex = /disconnect/i;
        if (regex.test(caption)) {
          ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify('#assistant stopped#')}));
          deepgram.finish();
          ws.close();
        }
        else {
          const responseText = await getGroqChat(caption, stack);
          log(`groq response: ${responseText}`)
          await playh(responseText)
          // await neets(responseText)
        }
      }
  });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      log('deepgram: disconnected')
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: packet received");
      console.log("deepgram: metadata received");
      console.log("ws: metadata sent to client");
      ws.send(JSON.stringify({ metadata: data }));
    });
  });

  return deepgram;
};

wss.on("connection", (ws) => {
  console.log("socket: client connected");
  log('socket: client connected')
  let deepgram = setupDeepgram(ws);

  ws.on("message", (message) => {

    if (deepgram.getReadyState() === 1 /* OPEN */) {
      deepgram.send(message);
    } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
      console.log("socket: data couldn't be sent to deepgram");
      console.log("socket: retrying connection to deepgram");
      log('reattempting to send data')
      /* Attempt to reopen the Deepgram connection */
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(socket);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  ws.on("close", () => {
    console.log("socket: client disconnected");
    log('socket: client disconnected')
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

server.listen(3000, () => {
  console.log("Server is listening on port 3000");
});
