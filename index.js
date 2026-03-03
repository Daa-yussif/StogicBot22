require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const Groq = require("groq-sdk");
const { MongoClient } = require("mongodb");

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const THANK_DELAY_MS = parseInt(process.env.THANK_DELAY_MS) || 180000;
const REMINDER_DAYS = parseInt(process.env.SUBSCRIPTION_REMINDER_DAYS) || 3;
const RENDER_URL = process.env.RENDER_URL;
const MONGO_URI = process.env.MONGO_URI;

// ====== MongoDB Setup ======
let db;
let leadsCol;
let subscriptionsCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("bot");
  leadsCol = db.collection("leads");
  subscriptionsCol = db.collection("subscriptions");

  console.log("✅ Connected to MongoDB");
}

// ====== Groq AI Setup ======
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const STOGIC_SYSTEM_PROMPT = `You are Stogic AI, a friendly and professional customer support assistant for Stogic Digital Solutions, a tech company based in Accra, Ghana.

Your job is to:
1. Answer questions about the company's services
2. Help customers understand pricing and options
3. Guide them to the right service
4. Be warm, professional and concise

Services offered:
- CCTV Installation: Starting from GHS 500 per camera. Includes optional remote monitoring (+GHS 300), accessories, and extended warranty (+GHS 200).
- Website Development: Business sites from GHS 2000, E-commerce from GHS 3500, Portfolio from GHS 1200, Custom from GHS 2500. Add-ons: CMS (+GHS 500), SEO (+GHS 300), Responsive Design (+GHS 300).
- Networking Solutions: GHS 100 per device. Add-ons: Extra services (+GHS 500), Accessories (+GHS 200), Maintenance contract (+GHS 300).
- Automation Services: 30-day plan GHS 500, 60-day GHS 900, 90-day GHS 1200. Add-ons: Custom replies (+GHS 200), Multi-channel (+GHS 500), Reporting (+GHS 300).

Company info:
- Location: Accra, Ghana
- Email: info@stogic.com
- Phone: +233 59 382 7001
- MoMo Payment: 0593827001 (Yussif Daa Mbazor)
- Website: https://stogic.com

Important rules:
- Keep responses under 150 words
- If someone wants a quote or wants to buy, tell them to type the service name (e.g. "CCTV", "Website", "Networking", "Automation") to start the process
- Never make up information not listed above
- Always be helpful and encouraging
- Respond in the same language the customer uses`;

// Store chat histories per user
const chatHistories = new Map();

async function askGroq(chatId, userMessage) {
  try {
    if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
    const history = chatHistories.get(chatId);

    const messages = [
      { role: "system", content: STOGIC_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage },
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 300,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || null;

    if (reply) {
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, 2);
    }

    return reply;
  } catch (err) {
    console.error("Groq error:", err.message);
    return null;
  }
}

// ====== Thank-You Timer ======
const thanksTimers = new Map();
function scheduleThankYou(chatId) {
  if (!chatId) return;
  if (thanksTimers.has(chatId)) clearTimeout(thanksTimers.get(chatId));
  const t = setTimeout(async () => {
    try {
      await bot.telegram.sendMessage(chatId, "🙏 Thanks for chatting with Stogic! Type 'hi' or select a service.");
    } finally {
      thanksTimers.delete(chatId);
    }
  }, THANK_DELAY_MS);
  thanksTimers.set(chatId, t);
}

// ====== Session State Machine ======
const sessions = new Map();
function getSession(chatId) { return sessions.get(chatId) || null; }
function setSession(chatId, session) { sessions.set(chatId, session); }
function clearSession(chatId) { sessions.delete(chatId); }

// ====== Main Menu ======
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ["🌐 Website Development", "📹 CCTV Installation"],
      ["🌍 Networking Solutions", "🤖 Automation Services"],
      ["💼 See Our Work", "📞 Contact Directly"],
      ["📍 Our Location", "🤖 Ask AI Assistant"],
    ],
    resize_keyboard: true,
  },
};

function sendMainMenu(ctx) {
  return ctx.reply("Please select a service or option:", MAIN_MENU);
}

// ====== Dynamic Pricing ======
function calculateCCTV({ cameras, remote, accessories, warranty }) {
  return cameras * 500 + (remote ? 300 : 0) + (accessories || 0) + (warranty ? 200 : 0);
}
function calculateWebsite({ baseType, extraPages, cms, seo, responsive }) {
  const base = { business: 2000, "e-commerce": 3500, portfolio: 1200 };
  let price = base[baseType.toLowerCase()] || 2500;
  if (extraPages) price += extraPages * 200;
  if (cms) price += 500;
  if (seo) price += 300;
  if (responsive) price += 300;
  return price;
}
function calculateNetworking({ devices, extraServices, accessories, maintenance }) {
  let price = devices * 100;
  if (extraServices) price += 500;
  if (accessories) price += 200;
  if (maintenance) price += 300;
  return price;
}
function calculateAutomation({ plan, customReplies, multiChannel, reporting }) {
  const base = { "30-day": 500, "60-day": 900, "90-day": 1200 };
  let price = base[plan] || 500;
  if (customReplies) price += 200;
  if (multiChannel) price += 500;
  if (reporting) price += 300;
  return price;
}

// ====== Lead Save & Notify ======
async function saveLead(ctx, service, totalPrice, subscriptionDays, details, contactInfo) {
  const { name, phone, location } = contactInfo;
  const chatId = ctx.chat.id;
  const paymentRef = "STG" + Date.now();
  const createdAt = new Date();

  // Save lead to MongoDB
  await leadsCol.insertOne({
    chatId,
    name,
    phone,
    location,
    service,
    totalPrice,
    subscriptionDays,
    details,
    paymentRef,
    paid: false,
    createdAt,
  });

  await bot.telegram.sendMessage(
    ADMIN_ID,
`🚨 *New Lead Alert!*
━━━━━━━━━━━━━━━
📦 Service: ${service}
👤 Name: ${name}
📱 Phone: ${phone}
📍 Location: ${location}
💰 Price: GHS ${totalPrice}
🔖 Ref: ${paymentRef}
━━━━━━━━━━━━━━━
⏳ Awaiting manual MoMo payment confirmation.`,
    { parse_mode: "Markdown" }
  );

  await ctx.reply(
    `✅ Your quote for *${service}* is *GHS ${totalPrice}*.\nOptions selected: ${JSON.stringify(details)}`,
    { parse_mode: "Markdown" }
  );

  await ctx.reply(
`💳 *How to Pay*
━━━━━━━━━━━━━━━
Send payment via Mobile Money:

📱 *MoMo Number:* 0593827001
👤 *Account Name:* Yussif Daa Mbazor

💰 *Amount:* GHS ${totalPrice}
🔖 *Reference:* ${paymentRef}

━━━━━━━━━━━━━━━
After payment, send your *payment screenshot* or *transaction ID* here and our team will confirm within *30 minutes*. ✅`,
    { parse_mode: "Markdown" }
  );
}

// ====== Session Step Handlers ======

// ---- CCTV ----
async function handleCCTVStep(ctx, session) {
  const text = ctx.message.text.trim();
  const step = session.step;

  if (step === "cameras") {
    const cameras = parseInt(text);
    if (isNaN(cameras) || cameras < 1) return ctx.reply("❌ Please enter a valid number of cameras (e.g. 4):");
    session.data.cameras = cameras;
    session.step = "remote";
    return ctx.reply("Remote monitoring? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "remote") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.remote = val === "yes";
    session.step = "accessories";
    return ctx.reply("Accessories cost in GHS? (Enter 0 if none):");
  }
  if (step === "accessories") {
    const acc = parseInt(text);
    if (isNaN(acc) || acc < 0) return ctx.reply("❌ Please enter a valid amount (e.g. 0 or 150):");
    session.data.accessories = acc;
    session.step = "warranty";
    return ctx.reply("Extended warranty? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "warranty") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.warranty = val === "yes";
    session.step = "name";
    const price = calculateCCTV(session.data);
    session.data._price = price;
    await ctx.reply(`💰 Estimated price: *GHS ${price}*\n\nNow please provide your *full name*:`, { parse_mode: "Markdown" });
    return;
  }
  if (step === "name") {
    session.data._name = text;
    session.step = "phone";
    return ctx.reply("Your *phone number*:", { parse_mode: "Markdown" });
  }
  if (step === "phone") {
    session.data._phone = text;
    session.step = "location";
    return ctx.reply("Your *location / area*:", { parse_mode: "Markdown" });
  }
  if (step === "location") {
    const { cameras, remote, accessories, warranty, _price, _name, _phone } = session.data;
    const details = { cameras, remote, accessories, warranty };
    await saveLead(ctx, "CCTV Installation", _price, 30, details, { name: _name, phone: _phone, location: text });
    clearSession(ctx.chat.id);
    return sendMainMenu(ctx);
  }
}

// ---- Website ----
async function handleWebsiteStep(ctx, session) {
  const text = ctx.message.text.trim();
  const step = session.step;

  if (step === "baseType") {
    const valid = ["business", "e-commerce", "portfolio", "custom"];
    if (!valid.includes(text.toLowerCase()))
      return ctx.reply("Please choose: *Business / E-commerce / Portfolio / Custom*", { parse_mode: "Markdown" });
    session.data.baseType = text.toLowerCase();
    session.step = "extraPages";
    return ctx.reply("Number of extra pages? (Enter 0 if none):");
  }
  if (step === "extraPages") {
    const n = parseInt(text);
    if (isNaN(n) || n < 0) return ctx.reply("❌ Please enter a valid number (0 or more):");
    session.data.extraPages = n;
    session.step = "cms";
    return ctx.reply("CMS Integration? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "cms") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.cms = val === "yes";
    session.step = "seo";
    return ctx.reply("SEO Optimization? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "seo") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.seo = val === "yes";
    session.step = "responsive";
    return ctx.reply("Responsive Design? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "responsive") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.responsive = val === "yes";
    session.step = "name";
    const price = calculateWebsite(session.data);
    session.data._price = price;
    await ctx.reply(`💰 Estimated price: *GHS ${price}*\n\nNow please provide your *full name*:`, { parse_mode: "Markdown" });
    return;
  }
  if (step === "name") {
    session.data._name = text;
    session.step = "phone";
    return ctx.reply("Your *phone number*:", { parse_mode: "Markdown" });
  }
  if (step === "phone") {
    session.data._phone = text;
    session.step = "location";
    return ctx.reply("Your *location / area*:", { parse_mode: "Markdown" });
  }
  if (step === "location") {
    const { baseType, extraPages, cms, seo, responsive, _price, _name, _phone } = session.data;
    const details = { baseType, extraPages, cms, seo, responsive };
    await saveLead(ctx, "Website Development", _price, 30, details, { name: _name, phone: _phone, location: text });
    clearSession(ctx.chat.id);
    return sendMainMenu(ctx);
  }
}

// ---- Networking ----
async function handleNetworkingStep(ctx, session) {
  const text = ctx.message.text.trim();
  const step = session.step;

  if (step === "devices") {
    const devices = parseInt(text);
    if (isNaN(devices) || devices < 1) return ctx.reply("❌ Please enter a valid number of devices:");
    session.data.devices = devices;
    session.step = "extraServices";
    return ctx.reply("Extra services needed? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "extraServices") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.extraServices = val === "yes";
    session.step = "accessories";
    return ctx.reply("Accessories cost in GHS? (Enter 0 if none):");
  }
  if (step === "accessories") {
    const acc = parseInt(text);
    if (isNaN(acc) || acc < 0) return ctx.reply("❌ Please enter a valid amount:");
    session.data.accessories = acc;
    session.step = "maintenance";
    return ctx.reply("Maintenance contract? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "maintenance") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.maintenance = val === "yes";
    session.step = "name";
    const price = calculateNetworking(session.data);
    session.data._price = price;
    await ctx.reply(`💰 Estimated price: *GHS ${price}*\n\nNow please provide your *full name*:`, { parse_mode: "Markdown" });
    return;
  }
  if (step === "name") {
    session.data._name = text;
    session.step = "phone";
    return ctx.reply("Your *phone number*:", { parse_mode: "Markdown" });
  }
  if (step === "phone") {
    session.data._phone = text;
    session.step = "location";
    return ctx.reply("Your *location / area*:", { parse_mode: "Markdown" });
  }
  if (step === "location") {
    const { devices, extraServices, accessories, maintenance, _price, _name, _phone } = session.data;
    const details = { devices, extraServices, accessories, maintenance };
    await saveLead(ctx, "Networking Solutions", _price, 30, details, { name: _name, phone: _phone, location: text });
    clearSession(ctx.chat.id);
    return sendMainMenu(ctx);
  }
}

// ---- Automation ----
async function handleAutomationStep(ctx, session) {
  const text = ctx.message.text.trim();
  const step = session.step;
  const PLAN_DAYS = { "30-day": 30, "60-day": 60, "90-day": 90 };

  if (step === "plan") {
    const plan = text.toLowerCase();
    if (!Object.keys(PLAN_DAYS).includes(plan))
      return ctx.reply("Please choose: *30-day / 60-day / 90-day*", { parse_mode: "Markdown" });
    session.data.plan = plan;
    session.step = "customReplies";
    return ctx.reply("Custom reply templates? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "customReplies") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.customReplies = val === "yes";
    session.step = "multiChannel";
    return ctx.reply("Multi-channel integration? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "multiChannel") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.multiChannel = val === "yes";
    session.step = "reporting";
    return ctx.reply("Reporting & analytics? *Yes / No*", { parse_mode: "Markdown" });
  }
  if (step === "reporting") {
    const val = text.toLowerCase();
    if (!["yes", "no"].includes(val)) return ctx.reply("Please reply *Yes* or *No*:", { parse_mode: "Markdown" });
    session.data.reporting = val === "yes";
    session.step = "name";
    const price = calculateAutomation(session.data);
    session.data._price = price;
    session.data._days = PLAN_DAYS[session.data.plan];
    await ctx.reply(`💰 Estimated price: *GHS ${price}*\n\nNow please provide your *full name*:`, { parse_mode: "Markdown" });
    return;
  }
  if (step === "name") {
    session.data._name = text;
    session.step = "phone";
    return ctx.reply("Your *phone number*:", { parse_mode: "Markdown" });
  }
  if (step === "phone") {
    session.data._phone = text;
    session.step = "location";
    return ctx.reply("Your *location / area*:", { parse_mode: "Markdown" });
  }
  if (step === "location") {
    const { plan, customReplies, multiChannel, reporting, _price, _days, _name, _phone } = session.data;
    const details = { plan, customReplies, multiChannel, reporting };
    await saveLead(ctx, "Automation Service", _price, _days, details, { name: _name, phone: _phone, location: text });
    clearSession(ctx.chat.id);
    return sendMainMenu(ctx);
  }
}

// ====== Bot Handlers ======
bot.start((ctx) => {
  scheduleThankYou(ctx.chat.id);
  clearSession(ctx.chat.id);
  ctx.reply(
    "👋 Welcome to *Stogic Digital Solutions*!\n\nI'm your AI-powered assistant. I can answer your questions, give quotes, and help you get started.\n\nHow can we help you today?",
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  const chatId = ctx.chat.id;

  scheduleThankYou(chatId);

  if (lower === "/cancel" || lower === "cancel") {
    clearSession(chatId);
    return ctx.reply("❌ Cancelled. Returning to main menu.", MAIN_MENU);
  }

  const session = getSession(chatId);
  if (session) {
    try {
      switch (session.flow) {
        case "cctv":       return await handleCCTVStep(ctx, session);
        case "website":    return await handleWebsiteStep(ctx, session);
        case "networking": return await handleNetworkingStep(ctx, session);
        case "automation": return await handleAutomationStep(ctx, session);
      }
    } catch (err) {
      console.error("Session error:", err);
      clearSession(chatId);
      return ctx.reply("⚠️ Something went wrong. Please try again.", MAIN_MENU);
    }
  }

  const isQuestion =
    lower.startsWith("what") || lower.startsWith("how") ||
    lower.startsWith("tell") || lower.startsWith("explain") ||
    lower.startsWith("why") || lower.startsWith("who") ||
    lower.startsWith("is ") || lower.startsWith("can ") ||
    lower.startsWith("do ") || lower.startsWith("does ") ||
    lower.startsWith("which") || lower.startsWith("where");

  if (isQuestion) {
    await ctx.sendChatAction("typing");
    const aiReply = await askGroq(chatId, text);
    if (aiReply) return ctx.reply(aiReply, { parse_mode: "Markdown" });
  }

  if (lower.includes("cctv")) {
    setSession(chatId, { flow: "cctv", step: "cameras", data: {} });
    return ctx.reply("📹 *CCTV Installation*\nHow many cameras do you need?", { parse_mode: "Markdown" });
  }
  if (lower.includes("website")) {
    setSession(chatId, { flow: "website", step: "baseType", data: {} });
    return ctx.reply("🌐 *Website Development*\nChoose your base type:\n*Business / E-commerce / Portfolio / Custom*", { parse_mode: "Markdown" });
  }
  if (lower.includes("network")) {
    setSession(chatId, { flow: "networking", step: "devices", data: {} });
    return ctx.reply("🌍 *Networking Solutions*\nHow many devices/users will be on the network?", { parse_mode: "Markdown" });
  }
  if (lower.includes("automation")) {
    setSession(chatId, { flow: "automation", step: "plan", data: {} });
    return ctx.reply("🤖 *Automation Services*\nChoose a plan:\n*30-day / 60-day / 90-day*", { parse_mode: "Markdown" });
  }

  if (lower.includes("see our work") || lower.includes("portfolio")) {
    return ctx.reply("💼 *Our Portfolio*\nCheck out our work at: https://stogic.com/portfolio\n\nFeel free to ask about any service!", { parse_mode: "Markdown" });
  }
  if (lower.includes("contact")) {
    return ctx.reply("📞 *Contact Us Directly*\n📧 Email: info@stogic.com\n📱 Phone: +233 59 382 7001\n\nOr just chat with us here!", { parse_mode: "Markdown" });
  }
  if (lower.includes("location")) {
    return ctx.reply("📍 *Our Location*\nWe are based in Accra, Ghana.\nWe serve clients nationwide and remotely.", { parse_mode: "Markdown" });
  }
  if (lower === "hi" || lower === "hello" || lower === "hey") {
    return ctx.reply("👋 Hello! Welcome to Stogic Digital Solutions. How can we help you today?", MAIN_MENU);
  }
  if (lower.includes("menu") || lower.includes("back to menu")) {
    return sendMainMenu(ctx);
  }

  await ctx.sendChatAction("typing");
  const aiReply = await askGroq(chatId, text);
  if (aiReply) return ctx.reply(aiReply, { parse_mode: "Markdown" });

  ctx.reply("❓ I didn't quite get that. Please select a service from the menu, or type *cancel* to reset.", {
    parse_mode: "Markdown",
    ...MAIN_MENU,
  });
});

// ===== Subscription Reminder Cron =====
cron.schedule("0 9 * * *", async () => {
  try {
    const now = Date.now();
    const subs = await subscriptionsCol.find({ expired: { $ne: true } }).toArray();

    for (const sub of subs) {
      const daysLeft = Math.ceil((sub.expiryDate - now) / (1000 * 60 * 60 * 24));

      if (daysLeft === REMINDER_DAYS) {
        await bot.telegram.sendMessage(sub.chatId,
          `⚠️ Reminder: Your *${sub.service}* subscription expires in ${REMINDER_DAYS} days. Contact us to renew!`,
          { parse_mode: "Markdown" }
        );
      }

      if (daysLeft <= 0) {
        await subscriptionsCol.updateOne(
          { _id: sub._id },
          { $set: { expired: true, paid: false } }
        );
        await bot.telegram.sendMessage(sub.chatId,
          `❌ Your *${sub.service}* subscription has expired. Contact us to renew!`,
          { parse_mode: "Markdown" }
        );
      }
    }
  } catch (err) {
    console.error("Cron job error:", err);
  }
});

// ===== Keep-alive for Render =====
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await axios.get(RENDER_URL);
      console.log("🔁 Keep-alive ping sent");
    } catch (err) {
      console.error("Keep-alive failed:", err.message);
    }
  }, 14 * 60 * 1000);
}

// ===== Graceful Shutdown =====
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ===== Start =====
const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Stogic Bot server running on port ${PORT}`));

    bot.launch()
      .then(() => console.log("🤖 Telegram bot launched"))
      .catch((err) => {
        console.error("❌ Bot launch failed:", err.message);
        process.exit(1);
      });
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  });