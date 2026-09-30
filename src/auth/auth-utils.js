const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'k6-studio-enterprise-jwt-secret-key-2026';
const SALT_ROUNDS = 10;

/**
 * Hash a plaintext password using bcrypt.
 */
async function hashPassword(plainPassword) {
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compare a plaintext password with a bcrypt hash.
 */
async function comparePassword(plainPassword, hash) {
    if (!plainPassword || !hash) return false;
    return bcrypt.compare(plainPassword, hash);
}

/**
 * Generate a signed JWT token.
 */
function generateToken(payload, expiresIn = '7d') {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

/**
 * Verify and decode a JWT token.
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

module.exports = {
    hashPassword,
    comparePassword,
    generateToken,
    verifyToken,
    JWT_SECRET
};
