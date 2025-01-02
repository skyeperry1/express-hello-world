import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import querystring from 'querystring'
import url from 'url'
import https from 'https'
import path from 'path'
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';

// Manually define __dirname in an ES module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    //process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
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
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'), // 'public' is the directory containing your HTML files
  prefix: '/', // Use '/' for serving at root or specify another prefix
});

fastify.post('/upload', async (request, reply) => {
  const jsonData = request.body;
  const responseData = await ingestBlueprint(jsonData);
  reply.status(200).send(responseData);
});

async function ingestBlueprint(jsonObject) {
  const jsonData = JSON.stringify(jsonObject);

  const options = {
      hostname: 'z80nue3ho9.execute-api.ca-central-1.amazonaws.com',
      port: 443,
      path: '/default/generate-preview',
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonData), // Updated to use Buffer.byteLength
      },
  };

  return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
          let responseBody = '';

          res.on('data', (chunk) => {
              responseBody += chunk;
          });

          res.on('end', () => {
              console.log(`External Response Status: ${res.statusCode}`);
              console.log(`External Response Headers: ${JSON.stringify(res.headers)}`);

              if (responseBody) {
                  try {
                      const data = JSON.parse(responseBody);
                      console.log("Parsed response data:", data);
                      resolve(data);
                  } catch (err) {
                      console.error('Error parsing JSON:', err);
                      reject(new Error('Error parsing response'));
                  }
              } else {
                  console.warn('Received empty response body');
                  reject(new Error('Received empty response body'));
              }
          });
      });

      req.on('error', (error) => {
          console.error('Request error:', error);
          reject(new Error('Failed to process JSON'));
      });

      // Send the JSON data
      req.write(jsonData);
      req.end();
  });
}



/**
 * 
 * @param {*} blueprintPIN 
 * @returns 
 */
async function getPromptFromDynamo(blueprintPIN) {

  const data = JSON.stringify({
    "blueprintPIN": blueprintPIN
  });

  const options = {
    hostname: 'z80nue3ho9.execute-api.ca-central-1.amazonaws.com',
    port: 443,
    path: '/default/retrieve-prompt',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        resolve(responseBody);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        
        console.log('[CLIENT CONNECTED]');

        // console.log(req);

        // console.log(req.query.blueprintPIN);


        // Connection-specific state
        let streamSid = null;
        let blueprintPIN = null;
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
        const initializeSession = async() => {
            console.log("initializeSession - BLUPRINT PIN",blueprintPIN);

            //Get Blueprint config from dynamoDb
            let response = await getPromptFromDynamo(blueprintPIN);            
            console.log("[RESPONSE]", response);
            let promptConfig = JSON.parse(response)


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
                    temperature: 0.65,
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
                    input_audio_transcription: {
                        model: 'whisper-1',
                      }
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
                            text: `Greet the user with "Thank you for contacting ${organization}", and then give the customer a one sentence summary of a few the things you can assist with(based off your functions/tool calls) and then say "how can I assist you today?"`
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

            // Send initial conversation item if AI talks first
            const sendFunctionAck = async(functionCallId) => {
              const functionAck = {
                  type: 'conversation.item.create',
                  item: {
                        type: 'function_call_output',
                        call_id: functionCallId,
                        output: JSON.stringify({success:true}),
                  }
              };

              await openAiWs.send(JSON.stringify(functionAck));
              await openAiWs.send(JSON.stringify({ type: 'response.create' }));
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

        let lastFunctionCallID = 
        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // if (LOG_EVENT_TYPES.includes(response.type)) {
                //     console.log(`Received event: ${response.type}`, response);
                // }
                sendRealtimeEventToPreivewWs(blueprintPIN, response);

                // if(response?.response?.output[0]?.type == "function_call"){
                //     console.log("[FUNCTION CALL]", response?.response?.output[0]?.type);
                //     if(response?.type == "response.done" && response?.response?.output[0]?.call_id){
                //       console.log("[RESPONSE DONE][SENDING ACK]", response?.response?.output[0]?.call_id);
                //       sendFunctionAck(response.response.output[0].call_id);
                //     }                 
                // }
                console.log("[Response]", response, (response?.type === "response.done"));

                if(response?.type === "response.done" && response?.output){
                    console.log("[RESPONSE DONE]");
                    response.output.forEach(async (output) => {
                        console.log("[OUTPUT]", output);
                        if(output?.type == "function_call"){
                            console.log("[FUNCTION CALL]", output?.call_id);
                            sendFunctionAck(output.call_id);
                          }   
                      });               
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
                        blueprintPIN = data.start.customParameters.blueprintPIN;
                        console.log('[blueprintPIN]', blueprintPIN);

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




/**
 * audit trail realtime events ws endpoint
 * 
 * 
 */
var connections = {}
// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/realtime-events', { websocket: true }, (connection, req) => {
        
        console.log('[CLIENT CONNECTED] - realtime-events');

        console.log(req.query.blueprintPIN);

        let blueprintPIN = req?.query?.blueprintPIN

        
        if(!blueprintPIN){
            console.log('[No Call ID in connection event] - realtime-events');
            connection.close();
        } else {
           connections[blueprintPIN] = {};
           connections[blueprintPIN] = connection;
        }

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            //Testing
            //sendRealtimeEventToPreivewWs(call_id, {test: 555});
        });

        // Handle connection close
        connection.on('close', () => {
            connections[blueprintPIN] = {};
        });


    });
});


function sendRealtimeEventToPreivewWs(blueprintPIN, event){
    if( connections[blueprintPIN]){
        if(!event?.type?.includes("delta")){
        connections[blueprintPIN].send(JSON.stringify(event));
        }
        //connections[blueprintPIN].send(event);
    }
}