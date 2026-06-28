function toIso(value) {
    if (!value) return new Date().toISOString()
    if (typeof value === 'string') return value
    if (typeof value.toDate === 'function') return value.toDate().toISOString()
    return new Date(value).toISOString()
}

function requireUser(authClient) {
    const user = authClient.currentUser
    if (!user) throw new Error('Not authenticated')
    return user
}

export function createFirebaseBackend({
    authClient,
    db,
    firestore,
    sendSignInLinkToEmail,
    signInWithEmailLink,
    isSignInWithEmailLink,
    signOut,
    getOrigin,
    getCurrentUrl,
    persistPendingEmail,
    getPendingEmail,
    clearPendingEmail,
}) {
    async function completePendingEmailLink(url) {
        if (!url || !isSignInWithEmailLink(authClient, url)) return

        const email = await getPendingEmail()
        if (!email) {
            return
        }

        await signInWithEmailLink(authClient, email, url)
        await clearPendingEmail()
    }

    return {
        auth: {
            async getUser() {
                await completePendingEmailLink(await getCurrentUrl())
                const user = authClient.currentUser
                return user ? { id: user.uid, email: user.email } : null
            },
            async signInMagicLink(email) {
                const actionCodeSettings = {
                    url: getOrigin(),
                    handleCodeInApp: true,
                }

                await sendSignInLinkToEmail(authClient, email, actionCodeSettings)
                await persistPendingEmail(email)
            },
            async signOut() {
                await signOut(authClient)
            },
        },
        core: {
            async ensurePersonalSpace() {
                const user = requireUser(authClient)
                const now = new Date().toISOString()
                const spaceId = `personal_${user.uid}`
                const membershipId = `${spaceId}_${user.uid}`

                const spaceRef = firestore.doc(db, 'spaces', spaceId)
                const membershipRef = firestore.doc(db, 'memberships', membershipId)
                const existing = await firestore.getDoc(spaceRef)

                const space = existing.exists()
                    ? { id: existing.id, ...existing.data() }
                    : { id: spaceId, name: 'Personal', created_by: user.uid, created_at: now }

                await firestore.setDoc(spaceRef, space, { merge: true })

                const membership = {
                    space_id: spaceId,
                    user_id: user.uid,
                    role: 'owner',
                    created_at: now,
                }
                await firestore.setDoc(membershipRef, membership, { merge: true })

                return { space, membership }
            },
            async listNotifications(spaceId) {
                const q = firestore.query(
                    firestore.collection(db, 'notifications'),
                    firestore.where('space_id', '==', spaceId),
                    firestore.orderBy('created_at', 'desc'),
                    firestore.limit(50),
                )
                const snapshot = await firestore.getDocs(q)
                return snapshot.docs.map((docSnap) => {
                    const data = docSnap.data()
                    return {
                        id: docSnap.id,
                        space_id: data.space_id,
                        user_id: data.user_id,
                        type: data.type,
                        payload_json: data.payload_json ?? {},
                        read_at: data.read_at ? toIso(data.read_at) : null,
                        created_at: toIso(data.created_at),
                        updated_at: toIso(data.updated_at),
                    }
                })
            },
            async markNotificationRead(id) {
                const now = new Date().toISOString()
                await firestore.updateDoc(firestore.doc(db, 'notifications', id), {
                    read_at: now,
                    updated_at: now,
                })
            },
        },
    }
}
