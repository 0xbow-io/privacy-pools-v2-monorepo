// Base e2e suite — a curated subset of the full suite, kept fast so it can
// run by default without waiting on full proof generation (~10 min).
// Run the full suite with `pnpm test:full` (sets TEST_SUITE=full).
import { describe } from "vitest";
import { detailsTests } from "./details/details.tests";
import { quoteTests } from "./quote/quote.tests";
import { baseRelayTests } from "./relay/relay.tests";

describe("Details", detailsTests);
describe("Quote", quoteTests);
baseRelayTests();
