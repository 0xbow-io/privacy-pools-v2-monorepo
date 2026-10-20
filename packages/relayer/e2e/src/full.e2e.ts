import { describe } from "vitest";
import { detailsTests } from "./details/details.tests";
import { quoteTests } from "./quote/quote.tests";
import { relayTests } from "./relay/relay.tests";
import { batchWithdrawalTests } from "./relay/batch.e2e";

describe("Details", detailsTests);
describe("Quote", quoteTests);
relayTests();
batchWithdrawalTests();
