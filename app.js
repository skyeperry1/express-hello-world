import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import querystring from 'querystring'
import url from 'url'

import { bpGeneratePromp } from "./bp_test.js";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `Assume the role of a customer service representative working for U+ Bank. You job is to assist customers in the call center. You can assist customers with the following tasks: 
-Address Change (Street, city, state, zipcode)
-File a complaint (location, date, complain details)
For each task you must collect the required data indicated within the parenthesis 
`;
const VOICE = 'alloy';
//const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
const HOST = ("RENDER" in process.env) ? `0.0.0.0` : `localhost`;
const PORT = process.env.PORT || 4000;

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// // Route for Twilio to handle incoming calls
// // <Say> punctuation to improve text-to-speech translation
// fastify.all('/incoming-call', async (request, reply) => {
//     try{
//         console.log("[INCOMING CALL] - ");
//     const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
//                           <Response>
//                           <Gather action="/connect-realtime" numDigits="6" finishOnKey="#" method="GET" >
//                           <Say>
//                               Please enter your 6 digit blueprint voice preview code,
//                               followed by the pound sign
//                           </Say>
//                       </Gather>
//                       <Say>We didn't receive any input. Goodbye!</Say>
//                           </Response>`;


//     reply.type('text/xml').send(twimlResponse);
//     console.log("[INCOMING CALL] - ");
//     } catch(e){
//         console.log("Error" , e);
//     }
// });

var DEVDIGITS =""

// fastify.all('/connect-realtime', async (request, reply) => {
//     try{
//         console.log("[CONNECT REALTIME] - 1");
//     const requestUrl = request.raw.client.parser.incoming.url;
//     const parsedUrl = url.parse(requestUrl);
//     // Parse the query string into an object
//     const queryObject = querystring.parse(parsedUrl.query);
//     // Access the `Digits` property
//     const digits = queryObject.Digits;
//     console.log("[CONNECT REALTIME] - 2");
//     console.log('Digits:', digits);
//     DEVDIGITS = digits
//     const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
//                           <Response>
//                           <Say>
//                         One moment
//                       </Say>
//                               <Connect>
//                                   <Stream url="wss://${request.headers.host}/media-stream" />
//                               </Connect>
//                           </Response>`;

//     reply.type('text/xml').send(twimlResponse);
//     } catch(err){
//         console.log("ERROR", err);
//     }
// });

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        
      console.log('[CLIENT CONNECTED]', req);


        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });


        
        // Control initial session with OpenAI
        const initializeSession = () => {

            let promptConfig = bpGeneratePromp();

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    //instructions: SYSTEM_MESSAGE,
                    instructions: promptConfig.prompt,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    // tools: [
                    //     {
                    //         type: "function",
                    //         name: "updateAddress",
                    //         description: "Called when the address change is ready to process.",
                    //         parameters: {
                    //             type: "object",
                    //             properties: {
                    //                 location: { "type": "string" }
                    //             },
                    //             required: ["location"]
                    //         }
                    //     }
                    // ],
                    tools:[...promptConfig.functions],
                    tool_choice: "auto",
                }
                

            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
             sendInitialConversationItem(promptConfig.organization);
        };



        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = (organization) => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: `Greet the user with "Thank you for contacting ${organization}, how can I assist you today?"`
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // if (LOG_EVENT_TYPES.includes(response.type)) {
                //     console.log(`Received event: ${response.type}`, response);
                // }

                if(response?.response?.output){
                    console.log("[FUNCTION CALL]", response.response.output);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        //console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({host: HOST, port: PORT }, function (err, address) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});


// import express from 'express';

// const app = express();
// const port = process.env.PORT || 3001;

// app.get("/", (req, res) => res.type('html').send(html));

// const server = app.listen(port, () => console.log(`Example app listening on port ${port}!`));

// server.keepAliveTimeout = 120 * 1000;
// server.headersTimeout = 120 * 1000;

// const html = `
// <!DOCTYPE html>
// <html>
//   <head>
//     <title>Hello from Render!</title>
//     <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js"></script>
//     <script>
//       setTimeout(() => {
//         confetti({
//           particleCount: 100,
//           spread: 70,
//           origin: { y: 0.6 },
//           disableForReducedMotion: true
//         });
//       }, 500);
//     </script>
//     <style>
//       @import url("https://p.typekit.net/p.css?s=1&k=vnd5zic&ht=tk&f=39475.39476.39477.39478.39479.39480.39481.39482&a=18673890&app=typekit&e=css");
//       @font-face {
//         font-family: "neo-sans";
//         src: url("https://use.typekit.net/af/00ac0a/00000000000000003b9b2033/27/l?primer=7cdcb44be4a7db8877ffa5c0007b8dd865b3bbc383831fe2ea177f62257a9191&fvd=n7&v=3") format("woff2"), url("https://use.typekit.net/af/00ac0a/00000000000000003b9b2033/27/d?primer=7cdcb44be4a7db8877ffa5c0007b8dd865b3bbc383831fe2ea177f62257a9191&fvd=n7&v=3") format("woff"), url("https://use.typekit.net/af/00ac0a/00000000000000003b9b2033/27/a?primer=7cdcb44be4a7db8877ffa5c0007b8dd865b3bbc383831fe2ea177f62257a9191&fvd=n7&v=3") format("opentype");
//         font-style: normal;
//         font-weight: 700;
//       }
//       html {
//         font-family: neo-sans;
//         font-weight: 700;
//         font-size: calc(62rem / 16);
//       }
//       body {
//         background: white;
//       }
//       section {
//         border-radius: 1em;
//         padding: 1em;
//         position: absolute;
//         top: 50%;
//         left: 50%;
//         margin-right: -50%;
//         transform: translate(-50%, -50%);
//       }
//     </style>
//   </head>
//   <body>
//     <section>
//       Hello from Render!
//     </section>
//   </body>
// </html>
// `