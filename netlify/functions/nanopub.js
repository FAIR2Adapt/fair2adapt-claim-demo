// Generate nanopublication TriG for AIDA sentences and quote+comment annotations.
// Signing is not yet implemented — these produce unsigned nanopub RDF.

const AIDA_TEMPLATE = "https://w3id.org/np/RALmXhDw3rHcMveTgbv8VtWxijUHwnSqhCmtJFIPKWVaA";
const QUOTE_TEMPLATE = "https://w3id.org/np/RA24onqmqTMsraJ7ypYFOuckmNWpo4Zv5gsLqhXt7xYPU";
const PROV_TEMPLATE = "https://w3id.org/np/RA7lSq6MuK_TIC6JMSHvLtee3lpLoZDOqLJCLXevnrPoU";
const PUBINFO_TEMPLATE_LICENSE = "https://w3id.org/np/RA0J4vUn_dekg-U1kK3AOEt02p9mT2WO03uGxLDec1jLw";
const PUBINFO_TEMPLATE_SIGNED = "https://w3id.org/np/RAukAcWHRDlkqxk7H2XNSegc1WnHI569INvNr-xdptDGI";
const SCIENCELIVE = "https://sciencelive4all.org/";
const LICENSE = "https://creativecommons.org/licenses/by/4.0/";

const AGENT_URI = process.env.NANOPUB_AGENT_URI || "https://w3id.org/np/RAIA9ECaN2ypOVvl4YeNjT6nbpwko9xMcctxB_uYscLG4/claude-ai-agent";
const AGENT_NAME = process.env.NANOPUB_AGENT_NAME || "claude-ai-agent";

function escapeTriG(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

function truncateLabel(text, maxLen = 100) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ---- AIDA Sentence nanopub ----
// claim: string (the AIDA sentence)
// doi: string (e.g. "10.3390/urbansci9020038")
// topics: [{label, uri}] (Wikidata URIs from enrich service)
export function generateAIDANanopub({ claim, doi, topics = [], isExample = true }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
  const aidaUri = `http://purl.org/aida/${encodeURIComponent(claim)}`;
  const doiUri = doi ? `https://doi.org/${doi}` : null;

  const topicTriples = topics
    .map((t) => `        schema1:about <${t.uri}>`)
    .join(" ;\n");

  const topicLabels = topics
    .map((t) => `    <${t.uri}> nt:hasLabelFromApi "${escapeTriG(t.label)}" .`)
    .join("\n");

  const trig = `@prefix cito: <http://purl.org/spar/cito/> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix hycl: <http://purl.org/petapico/o/hycl#> .
@prefix np: <http://www.nanopub.org/nschema#> .
@prefix npx: <http://purl.org/nanopub/x/> .
@prefix nt: <https://w3id.org/np/o/ntemplate/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema1: <http://schema.org/> .
@prefix sub: <https://w3id.org/sciencelive/np/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

sub:Head {
    sub: a np:Nanopublication ;
        np:hasAssertion sub:assertion ;
        np:hasProvenance sub:provenance ;
        np:hasPublicationInfo sub:pubinfo .
}

sub:assertion {
    <${aidaUri}> a hycl:AIDA-Sentence${doiUri ? ` ;\n        cito:obtainsSupportFrom <${doiUri}>` : ""}${topicTriples ? ` ;\n${topicTriples}` : ""} .
}

sub:provenance {
    sub:assertion prov:wasAttributedTo <${AGENT_URI}> .
}

sub:pubinfo {
    <${AGENT_URI}> foaf:name "${escapeTriG(AGENT_NAME)}" .

${topicLabels ? topicLabels + "\n" : ""}    sub: rdfs:label "AIDA sentence: ${escapeTriG(truncateLabel(claim))}" ;
        dct:created "${now}"^^xsd:dateTime ;
        dct:creator <${AGENT_URI}> ;
        dct:license <${LICENSE}> ;
        npx:hasNanopubType <http://purl.org/petapico/o/hycl>,
            hycl:AIDA-Sentence ;${isExample ? `\n        npx:hasNanopubType npx:ExampleNanopub ;` : ""}
        npx:introduces <${aidaUri}> ;
        npx:wasCreatedAt <${SCIENCELIVE}> ;
        nt:wasCreatedFromProvenanceTemplate <${PROV_TEMPLATE}> ;
        nt:wasCreatedFromPubinfoTemplate <${PUBINFO_TEMPLATE_LICENSE}>,
            <${PUBINFO_TEMPLATE_SIGNED}> ;
        nt:wasCreatedFromTemplate <${AIDA_TEMPLATE}> .
}
`;

  return trig;
}

// ---- Quote with comment nanopub ----
// quotation: string (the key sentence / exact quote from the paper)
// comment: string (the claim_extraction output / personal interpretation)
// doi: string (e.g. "10.3390/urbansci9020038")
export function generateQuoteNanopub({ quotation, comment, doi, isExample = true }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
  const doiUri = doi ? `https://doi.org/${doi}` : null;

  if (!doiUri) {
    return null; // Quote nanopubs require a DOI
  }

  const trig = `@prefix cito: <http://purl.org/spar/cito/> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix np: <http://www.nanopub.org/nschema#> .
@prefix npx: <http://purl.org/nanopub/x/> .
@prefix nt: <https://w3id.org/np/o/ntemplate/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sub: <https://w3id.org/sciencelive/np/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

sub:Head {
    sub: a np:Nanopublication ;
        np:hasAssertion sub:assertion ;
        np:hasProvenance sub:provenance ;
        np:hasPublicationInfo sub:pubinfo .
}

sub:assertion {
    <${doiUri}> cito:hasQuotedText "${escapeTriG(quotation)}" ;
        rdfs:comment "${escapeTriG(comment)}" .

    <${AGENT_URI}> cito:quotes <${doiUri}> .
}

sub:provenance {
    sub:assertion prov:wasAttributedTo <${AGENT_URI}> .
}

sub:pubinfo {
    <${AGENT_URI}> foaf:name "${escapeTriG(AGENT_NAME)}" .

    sub: rdfs:label "Paper annotation: ${escapeTriG(truncateLabel(quotation))}" ;
        dct:created "${now}"^^xsd:dateTime ;
        dct:creator <${AGENT_URI}> ;
        dct:license <${LICENSE}> ;
        npx:hasNanopubType cito:cites ;${isExample ? `\n        npx:hasNanopubType npx:ExampleNanopub ;` : ""}
        npx:wasCreatedAt <${SCIENCELIVE}> ;
        nt:wasCreatedFromProvenanceTemplate <${PROV_TEMPLATE}> ;
        nt:wasCreatedFromPubinfoTemplate <${PUBINFO_TEMPLATE_LICENSE}>,
            <${PUBINFO_TEMPLATE_SIGNED}> ;
        nt:wasCreatedFromTemplate <${QUOTE_TEMPLATE}> .
}
`;

  return trig;
}
