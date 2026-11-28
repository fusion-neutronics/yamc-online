// Who made each nuclear data library, what to cite for it, and the terms its
// data is redistributed under.
//
// Every result a run produces rests on evaluated libraries, and their
// evaluators ask to be cited wherever their data is used. The credits are
// copied from the table yamc and yani carry
// (fusion-neutronics/yamc-and-yani, crates/yamc-nuclide/src/storage/credits.rs),
// which also writes them into each release's NOTICE.md and each run's
// `data_releases`. Change a reference there and here together. yani-online
// carries the same credits in src/libraries.js.
//
// JEFF-4.0 is cited by its data sets until its journal paper is published, so
// each of its references names the set it is, and the Data tab cites only the
// sets the session read from. Every other library's references cover all of
// it.
//
// Nothing here touches the DOM or the network, so verify.mjs checks it under
// Node.

const CC_BY_4_0 = "Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/";

const TENDL_REFERENCES = Object.freeze([
  {
    text: 'A.J. Koning, D. Rochman, "Modern Nuclear Data Evaluation with the TALYS Code System", Nuclear Data Sheets 113 (2012) 2841-2934',
    doi: "10.1016/j.nds.2012.11.002",
  },
  {
    text: 'A.J. Koning, D. Rochman, J.-Ch. Sublet, N. Dzysiuk, M. Fleming, S. van der Marck, "TENDL: Complete Nuclear Data Library for Innovative Nuclear Science and Technology", Nuclear Data Sheets 155 (2019) 1-55',
    doi: "10.1016/j.nds.2019.01.002",
  },
]);

const TENDL_MADE_BY = "A.J. Koning and D. Rochman, who founded TENDL in 2008 and make it with the TALYS code system, with processing and benchmarking by J.-Ch. Sublet";

const TENDL_TERMS = "Publicly available from the TENDL project.";

// Where UKAEA's FISPACT-II data is published, and the terms it is
// redistributed under there.
const UKAEA_PAGE = "https://git.oecd-nea.org/fispact/nuclear_data";

const UKAEA_TERMS = "Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/, to the extent of the rights held by UKAEA and the other rights holders, who gave the OECD Nuclear Energy Agency permission to redistribute it in original and processed form. Upstream terms stricter than CC BY 4.0 take precedence for the parts they cover; the ENDF/B parts carry the US Government disclaimer. The data is provided as is, without warranty of any kind. Nothing in the licence waives the privileges and immunities of the OECD as an international organisation.";

/// One entry per library keyword. `library` is the name its makers use and
/// `references` what to cite, in the order its makers list it. A reference's
/// `doi` is empty for a credit its makers ask for in words rather than by a
/// paper, and its `set`, where given, is the data set it covers (see
/// `dataSet`).
export const CREDITS = Object.freeze({
  "endf-b8.1": {
    library: "ENDF/B-VIII.1",
    madeBy: "the Cross Section Evaluation Working Group (CSEWG), released by the National Nuclear Data Center, Brookhaven National Laboratory",
    page: "https://www.nndc.bnl.gov/endf-library/B-VIII.1/summary/",
    terms: "Publicly available from the National Nuclear Data Center; the US Government disclaimer applies.",
    references: [
      {
        text: 'G.P.A. Nobre, R. Capote, M.T. Pigni et al., "ENDF/B-VIII.1: Updated Nuclear Reaction Data Library for Science and Applications", Nuclear Data Sheets 210 (2026) 1-224',
        doi: "10.1016/j.nds.2026.04.001",
      },
      {
        text: "ENDF/B-VIII.1, Brookhaven National Laboratory (2024), the library itself",
        doi: "10.11578/endf/2571019",
      },
    ],
  },
  "jeff-4.0": {
    library: "JEFF-4.0",
    madeBy: "the Joint Evaluated Fission and Fusion (JEFF) project, coordinated by the OECD Nuclear Energy Agency Data Bank",
    page: "https://databank.io.oecd-nea.org/data/jeff/40/",
    terms: CC_BY_4_0,
    references: [
      {
        text: 'Joint Evaluated Fission and Fusion Project, "JEFF-4.0 Evaluated Data: neutron data", OECD Nuclear Energy Agency (2025)',
        doi: "10.82555/e9ajn-a3p20",
        set: "neutron",
      },
      {
        text: 'Joint Evaluated Fission and Fusion Project, "JEFF-4.0 Evaluated Data: radioactive decay data", OECD Nuclear Energy Agency (2025)',
        doi: "10.82555/tw0c6-t1386",
        set: "decay",
      },
      {
        text: 'Joint Evaluated Fission and Fusion Project, "JEFF-4.0 Evaluated Data: neutron induced fission products yields", OECD Nuclear Energy Agency (2025)',
        doi: "10.82555/trtwt-k2828",
        set: "fission_yields",
      },
      {
        text: 'Joint Evaluated Fission and Fusion Project, "JEFF-4.0 Evaluated Data: thermal scattering law data", OECD Nuclear Energy Agency (2025)',
        doi: "10.82555/scmva-nqh68",
        set: "thermal",
      },
    ],
  },
  "jendl-5.0": {
    library: "JENDL-5",
    madeBy: "the Nuclear Data Center of the Japan Atomic Energy Agency (JAEA)",
    page: "https://wwwndc.jaea.go.jp/jendl/j5/j5.html",
    terms: `${CC_BY_4_0}. JAEA requires the reference below to be cited wherever JENDL-5 is used.`,
    references: [
      {
        text: 'O. Iwamoto, N. Iwamoto, S. Kunieda, F. Minato et al., "Japanese evaluated nuclear data library version 5: JENDL-5", Journal of Nuclear Science and Technology 60 (2023) 1-60',
        doi: "10.1080/00223131.2022.2141903",
      },
    ],
  },
  "tendl-2025": {
    library: "TENDL-2025",
    madeBy: TENDL_MADE_BY,
    page: "https://tendl.imperial.ac.uk/tendl_2025/reference.html",
    terms: TENDL_TERMS,
    references: TENDL_REFERENCES,
  },
  "tendl-2017": {
    library: "TENDL-2017",
    madeBy: TENDL_MADE_BY,
    page: "https://tendl.imperial.ac.uk/tendl_2017/reference.html",
    terms: TENDL_TERMS,
    references: TENDL_REFERENCES,
  },
  "fendl-3.2d": {
    library: "FENDL-3.2d",
    madeBy: "the IAEA Nuclear Data Section, which coordinates the Fusion Evaluated Nuclear Data Library",
    page: "https://nds.iaea.org/fendl/",
    terms: "Publicly available from the IAEA Nuclear Data Section.",
    references: [
      {
        text: 'G. Schnabel, D.L. Aldama, T. Bohm, U. Fischer, S. Kunieda, A. Trkov et al., "FENDL: A library for fusion research and applications", Nuclear Data Sheets 193 (2024) 1-78',
        doi: "10.1016/j.nds.2024.01.001",
      },
    ],
  },
  "irdff-ii": {
    library: "IRDFF-II",
    madeBy: "the IAEA Nuclear Data Section, which coordinates the International Reactor Dosimetry and Fusion File",
    page: "https://www-nds.iaea.org/IRDFF/",
    terms: "Publicly available from the IAEA Nuclear Data Section.",
    references: [
      {
        text: 'A. Trkov, P.J. Griffin, S.P. Simakov, L.R. Greenwood, K.I. Zolotarev, R. Capote et al., "IRDFF-II: A New Neutron Metrology Library", Nuclear Data Sheets 163 (2020) 1-108',
        doi: "10.1016/j.nds.2019.12.001",
      },
    ],
  },
  "ukdd-2012": {
    library: "UKAEA decay_2012",
    madeBy: "UKAEA, which compiled it from JEFF-3.1.1, JEFF-3.1, JEFF-3.0, JEF-2.2, ENDF/B-VII, ENDF/B-VII.1, UKPADD-6.5 to 6.10, UKHEDD-2.2, EAF-2012, ENDF/A-6 and UKAEA evaluations and processed it for FISPACT-II; the OECD Nuclear Energy Agency redistributes it",
    page: UKAEA_PAGE,
    terms: UKAEA_TERMS,
    references: [
      {
        text: "decay_2012 data processed for FISPACT-II by UKAEA, from https://git.oecd-nea.org/fispact/nuclear_data, licensed under CC BY 4.0",
        doi: "",
      },
    ],
  },
  "ukdd-2020": {
    library: "UKAEA decay_2020",
    madeBy: "UKAEA, which compiled it from JEFF-3.3, JEF-2.2, JENDL/DDF-2015, ENDF/B-VIII.0, ENDF/B-VII, UKPADD-6.12, EAF-2012, ENDF/A-6 and UKAEA evaluations and processed it for FISPACT-II; the OECD Nuclear Energy Agency redistributes it",
    page: UKAEA_PAGE,
    terms: UKAEA_TERMS,
    references: [
      {
        text: "decay_2020 data processed for FISPACT-II by UKAEA, from https://git.oecd-nea.org/fispact/nuclear_data, licensed under CC BY 4.0",
        doi: "",
      },
      // JAEA requires its JENDL/DDF-2015 part to be cited.
      {
        text: 'J. Katakura, F. Minato, "JENDL Decay Data File 2015", JAEA-Data/Code 2015-030, Japan Atomic Energy Agency (2016)',
        doi: "10.11484/jaea-data-code-2015-030",
      },
    ],
  },
  "ukfy-4.2": {
    library: "UKFY-4.2",
    madeBy: "R.W. Mills (National Nuclear Laboratory), who evaluated its neutron-induced fission yields; UKAEA processed it for FISPACT-II, and the OECD Nuclear Energy Agency redistributes it",
    page: UKAEA_PAGE,
    terms: UKAEA_TERMS,
    references: [
      {
        text: "UKFY-4.2 data processed for FISPACT-II by UKAEA, from https://git.oecd-nea.org/fispact/nuclear_data, licensed under CC BY 4.0. Evaluation: R.W. Mills, National Nuclear Laboratory",
        doi: "",
      },
    ],
  },
});

/// The data set a fetched file belongs to, from the `<kind>/<name>` it sits
/// under in a release: `neutron/Fe56`, `photon/Fe`, `thermal/c_H_in_H2O`, or
/// `transmutation/<subsection>`. The reaction network and isomeric branching
/// are made from the neutron evaluations, so they are the neutron set.
export function dataSet(kind, name) {
  if (kind === "transmutation") {
    return name === "decay" || name === "fission_yields" ? name : "neutron";
  }
  return kind;
}

/// What to cite for the libraries a session read, `used` mapping each library
/// keyword to the set of data sets read from it: one entry per library, in
/// `used`'s order, with the references that cover what was read. Unknown
/// keywords are left out.
export function citations(used) {
  return [...used].filter(([id]) => CREDITS[id]).map(([id, sets]) => {
    const c = CREDITS[id];
    return {
      id,
      library: c.library,
      madeBy: c.madeBy,
      page: c.page,
      terms: c.terms,
      references: c.references.filter((r) => !r.set || sets.has(r.set)),
    };
  });
}

/// The resolvable link for a DOI.
export const doiUrl = (doi) => `https://doi.org/${doi}`;

const escapeCite = (s) => String(s).replace(/[&<>"']/g, (ch) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));

/// One reference as HTML: its text, and its DOI as a link where it has one.
function referenceHtml(r) {
  const text = escapeCite(r.text);
  if (!r.doi) return `<li>${text}</li>`;
  const url = escapeCite(doiUrl(r.doi));
  return `<li>${text}, <a href="${url}" target="_blank" rel="noopener">doi:${escapeCite(r.doi)}</a></li>`;
}

/// The citation list for the libraries a session read, as HTML.
export function citeListHtml(used) {
  const entries = citations(used).map((c) => (
    `<li class="cite-entry" data-library="${escapeCite(c.id)}">`
    + `<b>${escapeCite(c.library)}</b>, made by ${escapeCite(c.madeBy)}`
    + ` (<a href="${escapeCite(c.page)}" target="_blank" rel="noopener">library page</a>).`
    + `<ul class="cite-references">${c.references.map(referenceHtml).join("")}</ul>`
    + `<div class="cite-terms">Terms: ${escapeCite(c.terms)}</div>`
    + "</li>"
  ));
  return `<ul class="cite-list">${entries.join("")}</ul>`;
}
