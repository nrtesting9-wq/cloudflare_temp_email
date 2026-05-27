const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CANDIDATE_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[^\s<>,;:"'()[\]]+/g;
const LOCAL_EQUALS_DOMAIN_RE = /[A-Za-z0-9.!#$%&'*+/^_`{|}~-]+=[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BOUNCE_LOCAL_EQUALS_DOMAIN_RE = /^bounce[+._-][A-Za-z0-9]+[-_]([A-Za-z0-9][A-Za-z0-9.!#$%&'*+/^_`{|}~-]*=[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/i;

const RECIPIENT_HEADER_NAMES = [
    "x-original-to",
    "original-to",
    "delivered-to",
    "envelope-to",
    "resent-to",
    "to",
];

const TRACE_HEADER_NAMES = [
    "from",
    "sender",
    "reply-to",
    "return-path",
];

export function normalizeEmailAddress(value: string): string {
    try {
        let normalized = (value || "").trim().toLowerCase();
        if (normalized.startsWith("<") && normalized.endsWith(">")) {
            normalized = normalized.slice(1, -1).trim();
        }
        return BASIC_EMAIL_RE.test(normalized) ? normalized : "";
    } catch (error) {
        console.error("normalizeEmailAddress error", error);
        return "";
    }
}

export function extractOriginalRecipient(input: {
    address?: string;
    source?: string;
    rawEmail?: string;
    headers?: Headers;
}): string {
    try {
        const deliveredAddress = normalizeEmailAddress(input.address || "");
        const rawHeaders = parseRawHeaders(input.rawEmail || "");

        for (const headerName of RECIPIENT_HEADER_NAMES) {
            const selected = chooseCandidate(
                getHeaderValues(input.headers, rawHeaders, headerName)
                    .flatMap(extractRecipientCandidates),
                deliveredAddress
            );
            if (selected) return selected;
        }

        const sourceCandidate = chooseCandidate(
            extractTraceCandidates(input.source || ""),
            deliveredAddress
        );
        if (sourceCandidate) return sourceCandidate;

        for (const headerName of TRACE_HEADER_NAMES) {
            const selected = chooseCandidate(
                getHeaderValues(input.headers, rawHeaders, headerName)
                    .flatMap(extractTraceCandidates),
                deliveredAddress
            );
            if (selected) return selected;
        }
    } catch (error) {
        console.error("extractOriginalRecipient error", error);
    }
    return "";
}

export function getStoredOriginalRecipient(input: {
    address?: string;
    source?: string;
    rawEmail?: string;
    headers?: Headers;
}): string {
    return extractOriginalRecipient(input) || normalizeEmailAddress(input.address || "");
}

function chooseCandidate(candidates: string[], deliveredAddress: string): string {
    for (const candidate of unique(candidates)) {
        const normalized = normalizeEmailAddress(candidate);
        if (normalized && normalized !== deliveredAddress) {
            return normalized;
        }
    }
    return "";
}

function extractRecipientCandidates(value: string): string[] {
    if (!value) return [];
    return unique([
        ...extractDuckRewriteCandidates(value),
        ...extractLocalEqualsDomainCandidates(value),
        ...extractEmailCandidates(value),
    ]);
}

function extractTraceCandidates(value: string): string[] {
    if (!value) return [];
    return unique([
        ...extractDuckRewriteCandidates(value),
        ...extractLocalEqualsDomainCandidates(value),
    ]);
}

function extractEmailCandidates(value: string): string[] {
    return [...value.matchAll(EMAIL_CANDIDATE_RE)]
        .map((match) => cleanupCandidate(match[0]));
}

function extractLocalEqualsDomainCandidates(value: string): string[] {
    return [...value.matchAll(LOCAL_EQUALS_DOMAIN_RE)]
        .map((match) => normalizeLocalEqualsDomainCandidate(match[0]));
}

function extractDuckRewriteCandidates(value: string): string[] {
    const candidates: string[] = [];
    for (const email of extractEmailCandidates(value)) {
        const normalized = normalizeEmailAddress(email);
        if (!normalized) continue;
        const atIndex = normalized.lastIndexOf("@");
        const local = normalized.slice(0, atIndex);
        const domain = normalized.slice(atIndex + 1);
        const underscoreIndex = local.lastIndexOf("_");
        if (domain === "duck.com" && underscoreIndex >= 0 && underscoreIndex < local.length - 1) {
            candidates.push(`${local.slice(underscoreIndex + 1)}@${domain}`);
        }
    }
    return candidates;
}

function cleanupCandidate(value: string): string {
    return value.trim().replace(/^[<"'(]+|[>"'),.;:]+$/g, "");
}

function normalizeLocalEqualsDomainCandidate(value: string): string {
    const candidate = cleanupCandidate(value);
    const bounceMatch = candidate.match(BOUNCE_LOCAL_EQUALS_DOMAIN_RE);
    return (bounceMatch?.[1] || candidate).replace("=", "@");
}

function getHeaderValues(
    headers: Headers | undefined,
    rawHeaders: Map<string, string[]>,
    name: string
): string[] {
    const values: string[] = [];
    const headerValue = headers?.get(name);
    if (headerValue) values.push(headerValue);
    values.push(...(rawHeaders.get(name) || []));
    return values;
}

function parseRawHeaders(rawEmail: string): Map<string, string[]> {
    const headers = new Map<string, string[]>();
    const headerSection = getHeaderSection(rawEmail);
    if (!headerSection) return headers;

    const unfoldedLines: string[] = [];
    for (const line of headerSection.replace(/\r\n/g, "\n").split("\n")) {
        if (/^[ \t]/.test(line) && unfoldedLines.length > 0) {
            unfoldedLines[unfoldedLines.length - 1] += ` ${line.trim()}`;
        } else {
            unfoldedLines.push(line);
        }
    }

    for (const line of unfoldedLines) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) continue;
        const name = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        if (!name || !value) continue;
        const values = headers.get(name) || [];
        values.push(value);
        headers.set(name, values);
    }
    return headers;
}

function getHeaderSection(rawEmail: string): string {
    if (!rawEmail) return "";
    const crlfIndex = rawEmail.indexOf("\r\n\r\n");
    const lfIndex = rawEmail.indexOf("\n\n");
    if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex)) {
        return rawEmail.slice(0, crlfIndex);
    }
    if (lfIndex >= 0) {
        return rawEmail.slice(0, lfIndex);
    }
    return "";
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.length > 0))];
}
