const MAX_IMAGE_CHARS = 2_000_000;

export function cleanName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

export function nameKey(value) {
    return cleanName(value).toLowerCase();
}

export function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

export function sendError(res, error) {
    if (error?.code === 11000) {
        res.status(400).json({ message: 'This name is already saved.' });
        return;
    }
    if (error?.name === 'ValidationError') {
        res.status(400).json({ message: 'Check the required fields and try again.' });
        return;
    }
    const status = error?.status || 500;
    res.status(status).json({ message: error?.message || 'Server error' });
}

const MAX_NAME_LENGTH = 120;

export function requireName(value, label) {
    const name = cleanName(value);
    if (!name) throw httpError(400, `${label} is required.`);
    if (name.length > MAX_NAME_LENGTH) {
        throw httpError(400, `${label} must be ${MAX_NAME_LENGTH} characters or less.`);
    }
    return name;
}

export function idStrings(values) {
    const ids = new Set();
    (Array.isArray(values) ? values : []).forEach((value) => {
        if (value) ids.add(String(value));
    });
    return [...ids];
}

export function distinctCount(values) {
    return idStrings(values).length;
}

export function readImage(image, { required }) {
    if (!image || !image.data) {
        if (required) throw httpError(400, 'Image is required.');
        return { imageData: '', imageName: '' };
    }
    const data = String(image.data);
    if (!data.startsWith('data:image/')) {
        throw httpError(400, 'Upload an image file.');
    }
    if (data.length > MAX_IMAGE_CHARS) {
        throw httpError(400, 'Image must be under 1.5 MB.');
    }
    return {
        imageData: data,
        imageName: String(image.name || '').slice(0, 180),
    };
}
