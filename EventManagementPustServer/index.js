const express = require('express');
const app = express();
const cors = require('cors');
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, GridFSBucket, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// ===== Serverless-Optimized MongoDB Connection =====
const uri = process.env.MONGODB_URI || "mongodb+srv://shaoncsepust_db_user:Ynihbtbs1iaZjSeg@cluster0.spuqbyj.mongodb.net/?retryWrites=true&w=majority";
let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) {
        try {
            await cachedClient.db('admin').command({ ping: 1 });
            return cachedClient;
        } catch (e) {
            cachedClient = null;
        }
    }

    const client = new MongoClient(uri, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        },
        connectTimeoutMS: 5000,
        socketTimeoutMS: 30000,
        maxPoolSize: 1,
        retryWrites: true,
        retryReads: true
    });

    try {
        await client.connect();
        // Test the connection
        await client.db('admin').command({ ping: 1 });
        cachedClient = client;
        return client;
    } catch (error) {
        console.error('MongoDB connection error:', error);
        cachedClient = null;
        throw error;
    }
}

// Add this after your existing middleware and before the module.exports

// ===== User Endpoints =====
app.post('/users', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST'); // Use your DB name
        const usersCollection = db.collection('Users');

        const { email, name, userroll, uid } = req.body;

        // Validate required fields
        if (!email || !name || !uid) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if user already exists
        const existingUser = await usersCollection.findOne({
            $or: [{ email }, { uid }]
        });

        if (existingUser) {
            return res.status(409).json({
                error: 'User with this email or UID already exists'
            });
        }

        // Create new user document
        const newUser = {
            email,
            name,
            userroll: userroll || 'user', // Default to 'user' if not provided
            uid,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Insert into MongoDB
        const result = await usersCollection.insertOne(newUser);

        res.status(201).json({
            message: 'User created successfully',
            userId: result.insertedId,
            uid: uid
        });

    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Optional: Get user by UID
app.get('/users/:uid', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const usersCollection = db.collection('Users');

        let user = await usersCollection.findOne({ uid: req.params.uid });

        if (!user && req.query.email) {
            user = await usersCollection.findOne({ email: req.query.email });
            if (user) {
                await usersCollection.updateOne(
                    { _id: user._id },
                    { $set: { uid: req.params.uid, updatedAt: new Date() } }
                );
                user.uid = req.params.uid;
            }
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Don't send internal MongoDB _id to client
        const { _id, ...userData } = user;
        res.json(userData);


    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/users/:uid', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const usersCollection = db.collection('Users');

        const { uid } = req.params;
        const { name, description, image, members } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        // Update or create user document
        const result = await usersCollection.updateOne(
            { uid },
            {
                $set: {
                    name,
                    description: description || '',
                    image: image || '',
                    members: members || [],
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        // Return updated user (without _id)
        const updatedUser = await usersCollection.findOne({ uid });
        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found after update' });
        }

        const { _id, ...userData } = updatedUser;
        res.json(userData);

    } catch (error) {
        console.error('Full error in endpoint:', error);
        res.status(500).json({
            error: 'Internal server error',
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// ======= Add to your existing Express app (same format) =======



// === Verification submission + PDF to GridFS ===
const { v4: uuidv4 } = require('uuid'); // To generate unique notification IDs

app.post('/verify', upload.single('applicationPdf'), async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const verificationCollection = db.collection('Verifications');
        const userCollection = db.collection('Users');
        const notificationCollection = db.collection('Notification');
        const gfs = new GridFSBucket(db, { bucketName: 'pdfs' });

        // Validate required fields
        const requiredFields = ['name', 'email', 'contactNumber', 'userId'];
        const missingFields = requiredFields.filter(field => !req.body[field]);

        if (missingFields.length > 0) {
            return res.status(400).json({
                message: `Missing required fields: ${missingFields.join(', ')}`
            });
        }

        // Parse and validate data
        const {
            name,
            email,
            contactNumber,
            organizationLogo,
            userId,
            submittedAt,
            members = []
        } = req.body;

        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: 'Invalid email format' });
        }

        // Parse idCards safely
        let idCards = [];
        try {
            idCards = req.body.idCards ? JSON.parse(req.body.idCards) : [];
            if (!Array.isArray(idCards)) idCards = [];
        } catch (error) {
            return res.status(400).json({ message: 'Invalid idCards format' });
        }

        // Check if this is an update or new submission
        const existingVerification = await verificationCollection.findOne({ userId });
        const isUpdate = !!existingVerification;

        // PDF validation
        if (!req.file && !isUpdate) {
            return res.status(400).json({ message: 'PDF file is required for new submissions' });
        }

        // Upload PDF to GridFS
        const uploadPdfToGridFS = () => {
            return new Promise((resolve, reject) => {
                if (!req.file) return resolve(existingVerification?.pdfFileId || null);

                const uploadStream = gfs.openUploadStream(req.file.originalname, {
                    contentType: req.file.mimetype,
                    metadata: {
                        uploadedBy: userId,
                        uploadedAt: new Date()
                    }
                });

                uploadStream.end(req.file.buffer);

                uploadStream.on('finish', () => resolve(uploadStream.id));
                uploadStream.on('error', (err) => {
                    console.error('PDF upload error:', err);
                    reject(new Error('Failed to upload PDF'));
                });
            });
        };

        const pdfFileId = await uploadPdfToGridFS();

        // Prepare verification data
        const verificationData = {
            name,
            email,
            contactNumber,
            organizationLogo: organizationLogo || existingVerification?.organizationLogo || null,
            idCards: idCards.length > 0 ? idCards : existingVerification?.idCards || [],
            userId,
            submittedAt: submittedAt || existingVerification?.submittedAt || new Date().toISOString(),
            pdfFileId: pdfFileId || existingVerification?.pdfFileId || null,
            members: members.length > 0 ? members : existingVerification?.members || [],
            status: 'pending',
            lastUpdated: new Date().toISOString()
        };

        // Upsert verification document
        const verificationResult = await verificationCollection.updateOne(
            { userId },
            { $set: verificationData },
            { upsert: true }
        );

        // Update user verification status
        await userCollection.updateOne(
            { uid: userId },
            {
                $set: {
                    verificationStatus: 'pending',
                    lastVerificationUpdate: new Date().toISOString()
                }
            }
        );

        // Create appropriate notification
        const notificationId = `user-notif-${uuidv4()}`;
        const notificationType = isUpdate ? 'updated' : 'new';
        const notificationMessages = {
            new: {
                title: "Application Received",
                message: "Your verification request has been received and is under review."
            },
            updated: {
                title: "Application Updated",
                message: "Your verification information has been updated and is being re-reviewed."
            }
        };

        const newNotification = {
            id: notificationId,
            userId,
            type: "organizer-verification",
            title: notificationMessages[notificationType].title,
            message: notificationMessages[notificationType].message,
            relatedEntity: {
                type: "verification",
                id: verificationResult.upsertedId?.toString() || existingVerification?._id.toString()
            },
            status: "unread",
            createdAt: new Date().toISOString(),
            isUpdate
        };

        await notificationCollection.insertOne(newNotification);

        res.status(200).json({
            success: true,
            action: isUpdate ? "update" : "create",
            verificationId: verificationResult.upsertedId || existingVerification?._id,
            notification: {
                id: notificationId,
                title: newNotification.title,
                message: newNotification.message
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Verification processing error:', error);

        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Verification already exists for this user',
                solution: 'Your previous submission is still under review'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Internal server error',
            ...(process.env.NODE_ENV === 'development' && {
                error: error.message,
                stack: error.stack
            })
        });
    }
});


app.patch('/verifications/:verificationId', async (req, res) => {
    try {
        const { verificationId } = req.params;
        const { status, rejectionReason } = req.body;

        // Validate status
        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value. Must be one of: approved, rejected, pending'
            });
        }

        // If status is rejected, rejectionReason is required
        if (status === 'rejected' && !rejectionReason) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required when status is rejected'
            });
        }

        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const verificationCollection = db.collection('Verifications');
        const userCollection = db.collection('Users');
        const notificationCollection = db.collection('Notification');

        // Get the existing verification first
        const existingVerification = await verificationCollection.findOne({
            _id: new ObjectId(verificationId)
        });

        if (!existingVerification) {
            return res.status(404).json({
                success: false,
                message: 'Verification not found'
            });
        }

        // Prepare verification update object
        const updateData = {
            status: status,
            lastUpdated: new Date().toISOString(),
            ...(status === 'rejected' && { rejectionReason }),
            ...(status !== 'rejected' && { rejectionReason: null })
        };

        // Update the verification
        const updateResult = await verificationCollection.updateOne(
            { _id: new ObjectId(verificationId) },
            { $set: updateData }
        );

        if (updateResult.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Verification not found'
            });
        }

        // Prepare user update data
        const userUpdateData = {
            verificationStatus: status,
            lastVerificationUpdate: new Date().toISOString(),
            ...(status === 'approved' && {
                rejectionReason: null,
                contactNumber: existingVerification.contactNumber,
                organizationLogo: existingVerification.organizationLogo,
                idCards: existingVerification.idCards,
                pdfFileId: existingVerification.pdfFileId,
                members: JSON.parse(existingVerification.members || '[]'), // Parsed array
                userroll: "organizer"
            })
        };

        // Update user data
        await userCollection.updateOne(
            { uid: existingVerification.userId },
            { $set: userUpdateData }
        );

        // Create notification
        const newNotification = {
            _id: new ObjectId(),
            id: `user-notif-${uuidv4()}`,
            userId: existingVerification.userId,
            type: "organizer-verification",
            title: status === 'approved'
                ? "Verification Approved"
                : "Verification Rejected",
            message: status === 'approved'
                ? "Your organizer verification has been approved. You can now create events."
                : `Your verification was rejected. Reason: ${rejectionReason}`,
            relatedEntity: {
                type: "verification",
                id: verificationId
            },
            read: false,
            status: status,
            createdAt: new Date().toISOString(),
            sender: {
                id: "system",
                name: "System Notification",
                role: "system"
            },
            ...(status === 'rejected' && {
                rejectionReason,
                action: {
                    label: "Edit Application",
                    url: `/dashboard/${existingVerification.userId}/verification`
                }
            })
        };

        await notificationCollection.insertOne(newNotification);

        // Get the updated verification for response
        const updatedVerification = await verificationCollection.findOne({
            _id: new ObjectId(verificationId)
        });

        res.status(200).json({
            success: true,
            message: 'Verification status updated successfully',
            data: {
                verification: updatedVerification,
                notification: {
                    id: newNotification.id,
                    title: newNotification.title,
                    message: newNotification.message,
                    status: newNotification.status,
                    ...(status === 'rejected' && { action: newNotification.action })
                }
            }
        });

    } catch (error) {
        console.error('Error updating verification status:', error);

        if (error instanceof MongoError) {
            return res.status(500).json({
                success: false,
                message: 'Database operation failed',
                errorCode: error.code,
                ...(process.env.NODE_ENV === 'development' && {
                    errorDetails: error.message
                })
            });
        }

        res.status(500).json({
            success: false,
            message: 'Internal server error',
            ...(process.env.NODE_ENV === 'development' && {
                error: error.message,
                stack: error.stack
            })
        });
    }
});




app.get('/verifications', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const verificationCollection = db.collection('Verifications');

        const verifications = await verificationCollection
            .find({})
            .sort({ submittedAt: -1 }) // Optional: sort by latest submission
            .toArray();

        res.status(200).json(verifications);
    } catch (error) {
        console.error('Error fetching verifications:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
app.get('/verifications/user/:uid', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const verificationCollection = db.collection('Verifications');

        const userId = req.params.uid;

        // Find verification for this user, sorted by most recent first
        const verification = await verificationCollection
            .find({ userId })
            .sort({ submittedAt: -1 })
            .limit(1)
            .toArray();

        if (verification.length === 0) {
            return res.status(404).json({ message: 'No verification found for this user' });
        }

        res.status(200).json(verification[0]);
    } catch (error) {
        console.error('Error fetching user verification:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});


app.get('/pdfs', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');

        const bucket = new GridFSBucket(db, { bucketName: 'pdfs' });

        const filesCursor = bucket.find({});
        const files = await filesCursor.toArray();

        if (!files || files.length === 0) {
            return res.status(404).json({ message: 'No PDFs found' });
        }

        // Only return selected metadata
        const metadata = files.map(file => ({
            filename: file.filename,
            _id: file._id,
            uploadDate: file.uploadDate,
            length: file.length,
            contentType: file.contentType
        }));

        res.status(200).json(metadata);

    } catch (error) {
        console.error('Error fetching PDFs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// === Download/View PDF by ID ===
app.get('/pdf/:id', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const gfs = new GridFSBucket(db, { bucketName: 'pdfs' });
        const { ObjectId } = require('mongodb');

        const fileId = new ObjectId(req.params.id);
        gfs.openDownloadStream(fileId)
            .on('error', () => res.status(404).json({ message: 'File not found' }))
            .pipe(res);

    } catch (error) {
        console.error('Error fetching PDF:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});



// ===== Events Endpoints =====

// GET: Fetch all events
app.get('/events', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');

        const events = await eventsCollection
            .find()
            .sort({ eventDate: -1 }) // Sort newest event date first
            .toArray();

        res.status(200).json(events);
    } catch (error) {
        console.error('Error fetching events:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

app.post('/events/booked-timeslots', async (req, res) => {
    const { eventDate, venue } = req.body;

    if (!eventDate || !venue) {
        return res.status(400).json({ error: 'eventDate and venue are required.' });
    }

    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');

        const events = await eventsCollection.find({
            eventDate,
            venue
        }).toArray();

        const toMinutes = (timeStr) => {
            const [h, m] = timeStr.split('.').map(Number);
            return h * 60 + m;
        };

        const approvedSlots = [];
        const pendingSlots = [];

        events.forEach(event => {
            const start = toMinutes(event.duration.start);
            const end = toMinutes(event.duration.end);
            const range = [];

            for (let i = start; i < end; i += 30) {
                range.push(i);
            }

            if (event?.status?.approved) {
                approvedSlots.push(...range);
            } else {
                pendingSlots.push(...range);
            }
        });

        res.status(200).json({ approvedSlots, pendingSlots });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.patch('/approveevent/:id', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');
        const notificationCollection = db.collection('Notification');

        const eventQuery = ObjectId.isValid(req.params.id) ? { _id: new ObjectId(req.params.id) } : { _id: req.params.id };

        const result = await eventsCollection.findOneAndUpdate(
            eventQuery,
            {
                $set: {
                    'status.approved': true,
                    'status.active': true,
                    'status.isRejected': false,
                    'timestamps.updatedAt': new Date()
                }
            },
            { returnDocument: 'after' }
        );

        const event = result?.value || result;

        const notification = {
            _id: new ObjectId(),
            userId: event?.createdBy?.id || 'unknown',
            type: 'event',
            title: 'Event Approved',
            message: `Your event "${event?.name || 'Event'}" has been approved by the admin.`,
            relatedEntity: { type: 'event', id: req.params.id },
            createdAt: new Date().toISOString()
        };

        await notificationCollection.insertOne(notification);

        res.json(event || { success: true });
    } catch (err) {
        console.error('Approve error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

app.patch('/rejectevent/:id', async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }

        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');
        const notificationCollection = db.collection('Notification');

        const eventQuery = ObjectId.isValid(req.params.id) ? { _id: new ObjectId(req.params.id) } : { _id: req.params.id };

        const result = await eventsCollection.findOneAndUpdate(
            eventQuery,
            {
                $set: {
                    'status.approved': false,
                    'status.isRejected': true,
                    'timestamps.updatedAt': new Date()
                }
            },
            { returnDocument: 'after' }
        );

        const event = result?.value || result;

        const notification = {
            _id: new ObjectId(),
            userId: event?.createdBy?.id || 'unknown',
            type: 'event',
            title: 'Event Rejected',
            message: `Your event "${event?.name || 'Event'}" has been rejected by the admin.\nReason: ${reason}`,
            relatedEntity: { type: 'event', id: req.params.id },
            createdAt: new Date().toISOString()
        };

        await notificationCollection.insertOne(notification);

        res.json(event);
    } catch (err) {
        console.error('Reject error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});




app.delete('/deleteevent/:id', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');
        const notificationCollection = db.collection('Notification');

        const eventIdStr = req.params.id;

        // Validate the ID parameter
        if (!ObjectId.isValid(eventIdStr)) {
            return res.status(400).json({ error: 'Invalid event ID format' });
        }

        const eventId = new ObjectId(eventIdStr);

        // 1. Fetch event first to get creator info
        const event = await eventsCollection.findOne({ _id: eventId });

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // 2. Delete the event
        const result = await eventsCollection.deleteOne({ _id: eventId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Event not deleted' });
        }

        // 3. Notify the event creator
        const notification = {
            _id: new ObjectId(),
            userId: event.createdBy?.id || 'unknown',
            type: 'event',
            title: 'Event Deleted',
            message: `Your event "${event.name}" has been deleted by the admin.`,
            relatedEntity: {
                type: 'event',
                id: eventIdStr
            },

            createdAt: new Date().toISOString()
        };

        await notificationCollection.insertOne(notification);

        res.status(200).json({
            message: 'Event deleted and creator notified',
            deletedId: eventIdStr,
            notification
        });

    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// POST: Create a new event

app.post('/events', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const eventsCollection = db.collection('Events');
        const notificationCollection = db.collection('Notification');

        const newEvent = req.body;

        if (!newEvent.name || !newEvent.venue || !newEvent.eventDate || !newEvent.createdBy) {
            return res.status(400).json({ error: 'Missing required event fields' });
        }

        // Restrict regular students from creating events
        const userCollection = db.collection('Users');
        if (newEvent.createdBy?.id) {
            const creator = await userCollection.findOne({
                $or: [
                    { uid: newEvent.createdBy.id },
                    { email: newEvent.createdBy.email || '' }
                ]
            });
            if (creator && creator.userroll === 'user') {
                return res.status(403).json({ error: 'Regular students are not authorized to create events.' });
            }
        }

        // Add timestamps
        newEvent.timestamps = {
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Insert event
        const result = await eventsCollection.insertOne(newEvent);
        const eventId = result.insertedId;

        // Build notification
        const notification = {
            id: `event-notif-${uuidv4()}`,
            userId: newEvent.createdBy.id,
            type: "event-submission",
            title: "Event Submitted",
            message: `Your event "${newEvent.name}" has been submitted and is pending review.`,
            relatedEntity: {
                type: "event",
                id: eventId.toString()
            },
            sender: {
                id: "system",
                name: "Event System",
                role: "system"
            },
            status: "pending", // this can be used for admin review tracking
            read: false,
            createdAt: new Date().toISOString()
        };

        // Insert notification
        await notificationCollection.insertOne(notification);

        res.status(201).json({
            message: 'Event created successfully',
            eventId: eventId
        });

    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});






app.get('/notifications/:userId', async (req, res) => {
    const userId = req.params.userId;

    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const notificationCollection = db.collection('Notification');

        const notifications = await notificationCollection
            .find({ userId })
            .sort({ createdAt: -1 }) // newest first
            .toArray();

        if (!notifications.length) {
            return res.status(200).json([]); // instead of sending { message: ... }
        }


        res.status(200).json(notifications);

    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
app.patch('/notifications/read/:id', async (req, res) => {
    const notificationId = req.params.id;

    if (!ObjectId.isValid(notificationId)) {
        return res.status(400).json({ message: 'Invalid notification ID format' });
    }

    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const notificationCollection = db.collection('Notification');

        const result = await notificationCollection.updateOne(
            { _id: new ObjectId(notificationId) },
            { $set: { read: true } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: 'Notification not found.' });
        }

        res.status(200).json({ message: 'Notification marked as read.' });

    } catch (error) {
        console.error('Error updating notification status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});



app.get('/venues', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const venuesCollection = db.collection('Venues');

        const venues = await venuesCollection
            .find()
            .toArray();

        res.status(200).json(venues);
    } catch (error) {
        console.error('Error fetching venues:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

app.post('/venues', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const venuesCollection = db.collection('Venues');

        const newVenue = {
            title: req.body.title,
            image: req.body.image,
            description: req.body.description,
            guestCapacity: req.body.guestCapacity,
            rating: req.body.rating || {
                totalRating: 20,
                avgRating: 3.5
            },
            upcomingEvents: req.body.upcomingEvents || [{
                id: 1,
                programName: "",
                date: "",
                startingTime: "",
                endingTime: ""
            }],
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await venuesCollection.insertOne(newVenue);

        // Return the complete venue document with the generated _id
        const insertedVenue = {
            _id: result.insertedId,
            ...newVenue
        };

        res.status(201).json(insertedVenue);
    } catch (error) {
        console.error('Error creating venue:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});


app.put('/venues/:id', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const venuesCollection = db.collection('Venues');

        // Enhanced ID validation
        if (!req.params.id || !ObjectId.isValid(req.params.id)) {
            console.log('Invalid ID format:', req.params.id);
            return res.status(400).json({ error: 'Invalid venue ID format' });
        }

        const venueId = new ObjectId(req.params.id);
        console.log('Processing update for ID:', venueId);

        // Construct updates object from request body
        const updates = {
            ...req.body,
            updatedAt: new Date()
        };

        // Remove _id if present to prevent modification
        delete updates._id;

        console.log('Update data:', updates);

        const result = await venuesCollection.findOneAndUpdate(
            { _id: venueId },
            { $set: updates },
            {
                returnDocument: 'after',
                projection: { 
                    title: 1,
                    image: 1,
                    description: 1,
                    guestCapacity: 1,
                    rating: 1,
                    upcomingEvents: 1,
                    createdAt: 1,
                    updatedAt: 1
                }
            }
        );

        console.log('Full result object:', result);

        // NEW SUCCESS CHECK - works with all MongoDB driver versions
        if (!result.updatedAt) {
            console.log('No venue found with ID:', venueId);
            return res.status(404).json({ error: 'Venue not found' });
        }

        // Convert ObjectId to string for consistent response
        const responseData = {
            ...result,
            _id: result._id.toString()
        };

        res.status(200).json(responseData);
    } catch (error) {
        console.error('Full error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.delete('/venues/:id', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db('EventManagementPUST');
        const venuesCollection = db.collection('Venues');

        const result = await venuesCollection.deleteOne({
            _id: new ObjectId(req.params.id)
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Venue not found' });
        }

        res.status(200).json({
            message: 'Venue deleted successfully',
            deletedId: req.params.id
        });
    } catch (error) {
        console.error('Error deleting venue:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});




app.get('/', (req, res) => {
    res.send('Event Management PUST is running');
});

module.exports = app;

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}