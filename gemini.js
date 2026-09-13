/**
 * Calls Gemini directly from the device using the user's own API key.
 * There is no backend proxy — this app is for personal/single-user use, so
 * the key lives only in this device's IndexedDB and is sent straight to
 * Google. Do not ship this app to other users with your key baked in.
 *
 * Google renames/retires Gemini model ids fairly often, so the model id is
 * a setting (see index.html "Model" field) rather than hardcoded — check
 * Google AI Studio (aistudio.google.com) if requests start failing with a
 * 404, it usually means the configured model id was retired.
 */

function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function buildPrompt(categories) {
  const catLines = categories
    .map(c => `- id="${c.id}" (cap RM${c.cap}): ${c.label}. ${c.capNote}`)
    .join("\n");

  return `You are helping a Malaysian individual taxpayer sort a receipt photo for LHDN (Inland Revenue Board of Malaysia) personal income tax relief claims.

Read the receipt image and:
1. Identify the merchant name, the transaction date (YYYY-MM-DD), and the total amount paid (RM, numeric).
2. List the individual line items you can read.
3. Decide which of the following relief categories (if any) this receipt's items qualify for. A single receipt CAN match more than one category if it has mixed items (e.g. a bookstore receipt with both a novel and a fitness tracker). Only pick categories that plausibly apply under Malaysian LHDN rules — do not force a match.

Categories:
${catLines}

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "merchant": string,
  "date": "YYYY-MM-DD" or null,
  "amount": number or null,
  "items": string[],
  "matches": [
    { "categoryId": string, "confidence": number (0-1), "reason": string, "matchedItemText": string }
  ]
}
If nothing qualifies, return "matches": [].`;
}

async function analyzeReceiptWithGemini({ apiKey, model, imageBlob, categories }) {
  if (!apiKey) throw new Error("No Gemini API key configured");
  const base64 = await fileToBase64(imageBlob);
  const mimeType = imageBlob.type || "image/jpeg";

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: buildPrompt(categories) },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0.1 }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini request failed (HTTP ${res.status}). ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  const cleaned = text.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Gemini returned a response that wasn't valid JSON: " + cleaned.slice(0, 200));
  }
  return parsed;
}
