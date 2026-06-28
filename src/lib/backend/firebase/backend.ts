import type { Backend } from '../types'
import { auth, db } from './client'
import {
    isSignInWithEmailLink,
    sendSignInLinkToEmail,
    signInWithEmailLink,
    signOut as fbSignOut,
} from 'firebase/auth'
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { createFirebaseBackend } from './backend.shared.js'

export const backend = createFirebaseBackend({
    authClient: auth,
    db,
    firestore: { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where },
    sendSignInLinkToEmail,
    signInWithEmailLink,
    isSignInWithEmailLink,
    signOut: fbSignOut,
    getOrigin: () => window.location.origin,
    getCurrentUrl: () => window.location.href,
    persistPendingEmail: (email: string) => window.localStorage.setItem('firebase_emailForSignIn', email),
    getPendingEmail: () => window.localStorage.getItem('firebase_emailForSignIn'),
    clearPendingEmail: () => window.localStorage.removeItem('firebase_emailForSignIn'),
}) as Backend
