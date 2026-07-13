import { config as loadEnv } from "dotenv";
import { ActivityStore } from "../src/activityStore.js";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const [expectedName, email, ...keywords] = process.argv.slice(2);

if (!expectedName) {
  console.error('Usage: npm run watch:member -- "Andrew Ernst" a.ernst@acernst.com aernst acernst');
  process.exit(1);
}

const store = new ActivityStore(process.env.DATA_DIR || "./data");
const pending = await store.recordPendingWelcome({
  expectedName,
  email: email && email.includes("@") ? email : undefined,
  keywords: [
    ...(email && !email.includes("@") ? [email] : []),
    ...keywords,
  ],
  contractorCircleMember: true,
  note: "Stripe Contractor Circle Membership active.",
});

console.log(`Watching for ${pending.expectedName}.`);
console.log(`Pending welcome ID: ${pending.id}`);
console.log(`Match keywords: ${pending.keywords.join(", ")}`);
