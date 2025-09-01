import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import "dotenv/config";
import fs from "fs";
import { NewMessage } from "telegram/events/index.js";
import axios from "axios";

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const session = new StringSession(process.env.SESSION || "");
const targetChatUsername = process.env.TARGET_CHAT_USERNAME;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!apiId || !apiHash || !targetChatUsername || !discordWebhookUrl) {
  console.error(
    "Error: API_ID, API_HASH, TARGET_CHAT_USERNAME, and DISCORD_WEBHOOK_URL must be set in the .env file."
  );
  process.exit(1);
}

const LOG_FILE = "messages.log";

function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    console.error("Error writing to log file:", error);
  }
}

function extractTokenInfo(text) {
  const patterns = {
    tokenName: /\$([a-zA-Z0-9]+)/,
    ca: /`([a-zA-Z0-9]{32,44})`/,
    price: /\*\*Price:\*\* ([\$\d\.,]+)/,
    mc: /\*\*Market Cap:\*\* ([\$\d\.,kM]+)/,
    holders: /\*\*Holders:\*\* (\d+)/,
    top10: /\*\*Top10:\*\* ([\d\.]+%)/,
  };

  const extracted = {};
  for (const key in patterns) {
    const match = text.match(patterns[key]);
    if (match && match[1]) {
      extracted[key] = match[1];
    } else {
      return null;
    }
  }
  return extracted;
}

async function getPairAddress(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${tokenAddress}`;
    const response = await axios.get(url, { timeout: 10000 });
    if (response.data?.pairs?.length > 0) {
      const pairAddress = response.data.pairs[0].pairAddress;
      logToFile(`Found pair address for ${tokenAddress}: ${pairAddress}`);
      return pairAddress;
    }
    logToFile(`No pairs found for token: ${tokenAddress}`);
    return null;
  } catch (error) {
    console.error(
      "Error fetching pair address from DexScreener:",
      error.message
    );
    logToFile(`API Error fetching pair address: ${error.message}`);
    return null;
  }
}

async function sendToDiscord(info, pairAddress) {
  if (!info || !pairAddress) return;

  const pad = (str) => str.padEnd(11, " ");

  const statsValue = [
    `\`${pad("Price")}\` ${info.price}`,
    `\`${pad("Market Cap")}\` ${info.mc}`,
    `\`${pad("Holders")}\` ${info.holders}`,
    `\`${pad("Top 10")}\` ${info.top10}`,
  ].join("\n");

  const linksValue = [
    `[Axiom](https://axiom.trade/meme/${pairAddress}/@gravy)`,
    `[DexScreener](https://dexscreener.com/solana/${info.ca})`,
    `[Solscan](https://solscan.io/token/${info.ca})`,
  ].join(" • ");

  const embed = {
    color: 0x9046ff,
    author: {
      name: "✨ TRADE SIGNAL ✨",
    },
    title: `🪙 **$${info.tokenName}**`,
    description: `\`\`\`${info.ca}\`\`\``,
    fields: [
      {
        name: "📊 Token Stats",
        value: statsValue,
        inline: false,
      },
      {
        name: "🔗 Quick Links",
        value: linksValue,
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  try {
    await axios.post(discordWebhookUrl, {
      embeds: [embed],
    });
    logToFile(`Successfully forwarded embed to Discord.`);
  } catch (error) {
    const errorMessage = "Error sending embed to Discord:";
    console.error(errorMessage, error.message);
    logToFile(`DISCORD ERROR: ${errorMessage} ${error.message}`);
  }
}

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

function updateEnvFile(key, value) {
  try {
    const envPath = ".env";
    let envContent = fs.readFileSync(envPath, "utf-8");
    const keyRegex = new RegExp(`^${key}=.*$`, "m");

    if (keyRegex.test(envContent)) {
      envContent = envContent.replace(keyRegex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log(`Successfully updated ${key} in .env file.`);
  } catch (error) {
    console.error("Error updating .env file:", error);
    console.log(
      `\nPlease manually add this line to your .env file:\n${key}=${value}\n`
    );
  }
}

async function startUserbot() {
  console.log("Starting userbot...");
  logToFile("Userbot started");

  await client.start({
    phoneNumber: async () =>
      await input.text("Please enter your phone number: "),
    password: async () => await input.text("Please enter your 2FA password: "),
    phoneCode: async () =>
      await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });

  console.log("Userbot connected successfully!");
  logToFile("Userbot connected successfully");

  const currentSession = client.session.save();
  if (process.env.SESSION !== currentSession) {
    console.log("\n--- New Session String ---");
    console.log(
      "Your new session string has been generated. Saving to .env file..."
    );
    updateEnvFile("SESSION", currentSession);
    console.log("--------------------------\n");
    logToFile("New session string generated and saved");
  }

  try {
    const targetEntity = await client.getEntity(targetChatUsername);
    const targetChatId = targetEntity.id.toString();

    console.log(
      `Now listening for new messages from: ${targetChatUsername} (ID: ${targetChatId})`
    );
    logToFile(
      `Listening for messages from: ${targetChatUsername} (ID: ${targetChatId})`
    );

    async function handleNewMessage(event) {
      const message = event.message;

      if (
        message &&
        message.text &&
        !message.out &&
        message.chatId &&
        message.chatId.toString() === targetChatId
      ) {
        const logMessage = `[From: @${targetChatUsername}] Message: "${message.text}"`;
        console.log("^^^ MESSAGE MATCHED! ^^^");
        logToFile(`MESSAGE RECEIVED: ${logMessage}`);

        const info = extractTokenInfo(message.text);

        if (info) {
          logToFile(`Extracted ${info.tokenName}. Fetching pair address...`);
          console.log(`Extracted ${info.tokenName}. Fetching pair address...`);

          const pairAddress = await getPairAddress(info.ca);

          if (pairAddress) {
            console.log(
              "Pair address found. Sending formatted embed to Discord..."
            );
            await sendToDiscord(info, pairAddress);
          } else {
            logToFile(
              `Could not find pair address for ${info.ca}. Skipping Discord forward.`
            );
            console.log(
              "Could not find pair address. Message will not be forwarded."
            );
          }
        } else {
          logToFile(
            "Message did not match expected format. Skipping Discord forward."
          );
          console.log("Message format not recognized, will not be forwarded.");
        }
      }
    }

    client.addEventHandler(handleNewMessage, new NewMessage({}));
  } catch (error) {
    const errorMessage = `Could not find the chat for username: ${targetChatUsername}. Please check the username and try again.`;
    console.error(errorMessage);
    console.error(error);
    logToFile(`ERROR: ${errorMessage}`);
    logToFile(`ERROR DETAILS: ${error.message}`);
    await client.disconnect();
  }
}

startUserbot().catch((err) => {
  const errorMessage = "An unexpected error occurred:";
  console.error(errorMessage, err);
  logToFile(`FATAL ERROR: ${errorMessage} ${err.message}`);
});
