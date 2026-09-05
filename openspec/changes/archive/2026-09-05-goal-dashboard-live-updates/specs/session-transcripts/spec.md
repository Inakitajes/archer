## Purpose

Define what a run dashboard's session tab shows for each phase: the verbatim live stream while a watched step runs, and reconstruction from the run's live server for sessions the dashboard did not watch from the start, so an operator who attaches late — or re-attaches mid-run — can still read what a step said and did.

## ADDED Requirements

### Requirement: The session tab streams a watched phase live
While a phase's session is being watched, the session tab SHALL stream the model's verbatim reasoning and response text plus one-line tool and shell action markers as they arrive, tailing the newest content until the operator scrolls up.

#### Scenario: Live stream renders as it arrives
- **WHEN** a watched step is streaming a response
- **THEN** the session tab shows the reasoning and response text and tool markers as they arrive, without waiting for the step to complete

### Requirement: Sessions not watched from the start are reconstructed from the live server
When a dashboard begins following a run whose server is reachable and a phase has a recorded session identifier, the dashboard SHALL reconstruct that session's transcript from the server's session history — including phases that already completed before the dashboard attached — instead of leaving a no-messages placeholder. Reconstructed content SHALL merge with any live stream of the same session without duplicating messages, and reconstruction MUST NOT fabricate content for sessions the server cannot return. A stopped or historical run whose server is gone SHALL keep the honest placeholder, with any stored-session reopening behaving as today.

#### Scenario: Re-attach mid-run shows the running step's earlier output
- **WHEN** an operator detaches and re-attaches while a step is mid-stream
- **THEN** the session tab shows the messages streamed before the re-attach and continues tailing the live stream without duplicating them

#### Scenario: A completed step remains readable after a late attach
- **WHEN** an operator attaches to a live goal run after a measurement round completed
- **THEN** the completed scoring steps' session tabs show what those sessions said and did, reconstructed from the live server, rather than "no streamed messages captured for this step"

#### Scenario: Historical runs do not invent transcripts
- **WHEN** a stopped run whose server is gone is reopened from history
- **THEN** phases without stored sessions show the existing placeholder, and nothing claims transcript content the dashboard does not have
