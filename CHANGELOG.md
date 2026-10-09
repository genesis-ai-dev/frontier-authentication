# Change Log

All notable changes to the "frontier-authentication" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Fix: Sync no longer fails on large remote updates. Conflict analysis now reads file versions with bounded concurrency (16 at a time) instead of launching one git process per changed file, which exhausted the per-user process limit on macOS. A file version that cannot be read now stops the sync with a retriable `BLOB_READ_FAILED:` error instead of being treated as empty content and silently dropped from the conflict list (#40).
- Fix: Publish now stages media with Git LFS just like Sync. Large audio and attachments are uploaded to LFS and pointers are committed during the initial publish.
