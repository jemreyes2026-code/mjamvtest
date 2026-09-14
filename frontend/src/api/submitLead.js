import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, isFirebaseConfigured } from './firebase.js';
import { SERVICES } from '../data/services.js';

const SCRIPT_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();

/**
 * The <select> submits its option value ("exhaust"), which is meaningless to
 * whoever reads the spreadsheet or the Firebase console. Translate it back to
 * the human name ("Kitchen Exhaust Cleaning") before it leaves the browser.
 */
const SERVICE_LABELS = Object.fromEntries(SERVICES.map((s) => [s.formValue, s.name]));

function readableService(value) {
  return SERVICE_LABELS[value] || value || '';
}

/**
 * Writes a lead to Firestore's `leads` collection — the collection
 * firestore.rules validates and the system of record for the site.
 * Field set must match isValidLead() in firestore.rules exactly.
 */
async function submitToFirestore({ name, phone, email, service, date, time, message, source }) {
  const lead = { name, phone, service: readableService(service), source, createdAt: serverTimestamp() };
  if (email) lead.email = email;
  if (date) lead.date = date;
  if (time) lead.time = time;
  if (message) lead.message = message;
  await addDoc(collection(db, 'leads'), lead);
}

/** Optional Sheets copy. Require a readable acknowledgement from Apps Script. */
async function submitToSheet(form, data) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(SCRIPT_URL) || SCRIPT_URL.includes('REPLACE_WITH')) {
    throw new Error('Google Sheets submission endpoint is not configured.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      // A simple request avoids the preflight unsupported by Apps Script.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: controller.signal,
      body: JSON.stringify({
        ...data,
        service: readableService(data.service),
        form,
        submittedAt: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error('Google Sheets endpoint could not be reached.');
    const result = await response.json();
    if (result.ok !== true) throw new Error('Google Sheets did not confirm saving the submission.');
  } finally {
    clearTimeout(timer);
  }
}

export async function submitLead(form, data) {
  if (!isFirebaseConfigured) {
    throw new Error('Firebase submission backend is not configured.');
  }

  // Only report success after Firestore confirms the lead was saved.
  await submitToFirestore(data);

  // A slow or unavailable Sheets endpoint must not block the database save.
  if (SCRIPT_URL) {
    void submitToSheet(form, data).catch((error) => {
      console.warn('Google Sheets copy failed; lead saved to Firebase:', error);
    });
  }
}
