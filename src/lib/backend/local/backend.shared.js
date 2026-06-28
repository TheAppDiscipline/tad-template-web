export const LOCAL_STORAGE_KEYS = Object.freeze({
    user: 'discipline_local_user',
    space: 'discipline_local_space',
    notifications: 'discipline_local_notifications',
})

function readJson(storage, key, fallback) {
    const raw = storage.getItem(key)
    if (!raw) return fallback; try { return JSON.parse(raw); } catch { return fallback; }
}

function writeJson(storage, key, value) {
    storage.setItem(key, JSON.stringify(value))
}

export function createLocalBackend({ storage, randomUUID, now }) {
    function getOrCreateUser() {
        const existing = readJson(storage, LOCAL_STORAGE_KEYS.user, null)
        if (existing) return existing

        const user = { id: randomUUID(), email: null }
        writeJson(storage, LOCAL_STORAGE_KEYS.user, user)
        return user
    }

    function getOrCreatePersonalSpace(userId) {
        const existing = readJson(storage, LOCAL_STORAGE_KEYS.space, null)
        if (existing) return existing

        const timestamp = now()
        const space = {
            id: randomUUID(),
            name: 'Personal',
            created_by: userId,
            created_at: timestamp,
        }
        const membership = {
            space_id: space.id,
            user_id: userId,
            role: 'owner',
            created_at: timestamp,
        }
        const payload = { space, membership }
        writeJson(storage, LOCAL_STORAGE_KEYS.space, payload)
        return payload
    }

    function readNotifications() {
        return readJson(storage, LOCAL_STORAGE_KEYS.notifications, [])
    }

    function writeNotifications(list) {
        writeJson(storage, LOCAL_STORAGE_KEYS.notifications, list)
    }

    return {
        auth: {
            async getUser() {
                return getOrCreateUser()
            },
            async signInMagicLink(_) {
                const user = getOrCreateUser()
                writeJson(storage, LOCAL_STORAGE_KEYS.user, user)
            },
            async signOut() {
                return undefined
            },
        },
        core: {
            async ensurePersonalSpace() {
                const user = getOrCreateUser()
                return getOrCreatePersonalSpace(user.id)
            },
            async listNotifications(spaceId) {
                return readNotifications().filter((notification) => notification.space_id === spaceId)
            },
            async markNotificationRead(id) {
                const timestamp = now()
                const updated = readNotifications().map((notification) =>
                    notification.id === id
                        ? { ...notification, read_at: timestamp, updated_at: timestamp }
                        : notification
                )
                writeNotifications(updated)
            },
        },
    }
}
