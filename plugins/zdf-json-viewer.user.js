// ==UserScript==
// @name         ZDF JSON Viewer
// @match        *://www.zdf.de/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

// Tampermonkey-Version des ZDF-JSON-Bookmarklets. Nutzt bewusst dieselbe
// Anfrage-Logik wie das funktionierende Bookmarklet (plain fetch() im
// Seitenkontext, videoByCanonical mit dem letzten URL-Pfadsegment als
// $canonical) statt der alten getjson.js-Variante (videoById + $id +
// GM_xmlhttpRequest-Zweiphasenlogik), die keine Daten mehr zurückgab.

(function () {
  "use strict";

  const QUERY = `
    query VideoByCanonical($canonical: String!, $first: Int) {
      videoByCanonical(canonical: $canonical) {
        id
        canonical
        recoModel
        contentType
        title
        sharingUrl
        leadParagraph
        editorialDate
        teaser {
          image {
            altText
            caption
            list
          }
        }
        contentOwner {
          title
          details
        }
        streamingOptions {
          ad
          ut
          dgs
          ov
          ks
          fsk
        }
        episodeInfo {
          episodeNumber
          seasonNumber
          hideEpisodeInformation
        }
        structuralMetadata {
          isChildrenContent
          genreInfo {
            original
            transformed
          }
          publicationFormInfo {
            original
            transformed
          }
          visualDimension {
            moods(first: $first) {
              nodes {
                mood
              }
            }
          }
        }
        smartCollection {
          id
          canonical
          title
          collectionType
          sharingUrl
          structuralMetadata {
            contentFamily
            publicationFormInfo {
              original
              transformed
            }
          }
        }
        seo {
          title
        }
        availability {
          fskBlocked
          vod {
            visible
            visibleFrom
            visibleTo
            fsk
          }
        }
        currentMediaType
        subtitle
        webUrl
        embeddingPossible
        publicationDate
        external {
          streamAnchorSourceUrl
          streamAnchorSourceUrlTemplate
        }
        currentMedia {
          nodes {
            ptmdTemplate
            ... on VodMedia {
              duration
              aspectRatio
              visible
              geoLocation
              highestVerticalResolution
              streamAnchorTags {
                nodes {
                  anchorOffset
                  anchorLabel
                }
              }
              skipIntro {
                startIntroTimeOffset
                stopIntroTimeOffset
                skipButtonDisplayTime
                skipButtonLabel
              }
              vodMediaType
              label
              contentType
            }
            ... on LiveMedia {
              geoLocation
              tvService
              title
              start
              stop
              editorialStart
              editorialStop
              encryption
              liveMediaType
              label
            }
            id
          }
        }
        tracking {
          nielsen
          zdf
          piano(filter: video)
        }
        nextEditorialVideo {
          id
          canonical
          recoModel
          contentType
          title
          sharingUrl
          leadParagraph
          editorialDate
          teaser {
            image {
              altText
              caption
              list
            }
          }
          contentOwner {
            title
            details
          }
          streamingOptions {
            ad
            ut
            dgs
            ov
            ks
            fsk
          }
          episodeInfo {
            episodeNumber
            seasonNumber
            hideEpisodeInformation
          }
          structuralMetadata {
            isChildrenContent
            genreInfo {
              original
              transformed
            }
            publicationFormInfo {
              original
              transformed
            }
            visualDimension {
              moods(first: $first) {
                nodes {
                  mood
                }
              }
            }
          }
          smartCollection {
            id
            canonical
            title
            collectionType
            sharingUrl
            structuralMetadata {
              contentFamily
              publicationFormInfo {
                original
                transformed
              }
            }
          }
          seo {
            title
          }
          availability {
            fskBlocked
            vod {
              visible
              visibleFrom
              visibleTo
              fsk
            }
          }
          currentMedia {
            nodes {
              ptmdTemplate
              ... on VodMedia {
                duration
              }
            }
          }
        }
      }
    }
  `;

  function getToken() {
    const scripts = [...document.querySelectorAll("script")];
    const tokenScript = scripts.find(s => s.textContent && s.textContent.includes("apiAuthToken"));
    if (!tokenScript) {
      console.error("Token-Script nicht gefunden!");
      return null;
    }
    const match = tokenScript.textContent.match(/apiAuthToken\\\":\\\"([^"]+)\\/);
    if (!match) {
      console.error("Token nicht gefunden!");
      return null;
    }
    return match[1];
  }

  async function showJson() {
    const canonical = location.pathname.substring(location.pathname.lastIndexOf("/") + 1);
    const token = getToken();
    if (!token) {
      alert("Kein API-Token auf der Seite gefunden.");
      return;
    }

    try {
      const response = await fetch("https://api.zdf.de/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", "api-auth": `Bearer ${token}` },
        body: JSON.stringify({ query: QUERY, variables: { canonical, first: 1 } })
      });
      const json = await response.json();
      if (json.errors?.length) {
        alert(`GraphQL-Fehler: ${json.errors[0].message}`);
        return;
      }
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: "application/json" });
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e) {
      console.error("[zdf-json-viewer]", e);
      alert(`Anfrage fehlgeschlagen: ${e.message}`);
    }
  }

  GM_registerMenuCommand("Zeige Video-JSON", showJson);
})();
