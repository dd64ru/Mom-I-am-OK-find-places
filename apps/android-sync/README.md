# Android sync companion scaffold

This directory reserves the client boundary; it contains no Gradle project, chosen package name, Firebase Android registration, certificate or fake OsmAnd bridge. See [the technical plan](../../docs/android-sync.md).

Next task: decide the Android application ID, implement a small Kotlin companion using Firebase Google authentication and Firestore offline caching, and validate installed OsmAnd AIDL capabilities on a physical device. The canonical schemas and Firestore hierarchy already exist. Navigation and map rendering remain in OsmAnd.
