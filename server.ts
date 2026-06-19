import { Elysia, t } from 'elysia';
import { PrismaClient } from '@prisma/client';
import { jwt } from '@elysiajs/jwt';
import { staticPlugin } from '@elysiajs/static';
import { cors } from '@elysiajs/cors';
import sharp from 'sharp';
import { store_url } from './config';
import axios from 'axios';
import { Server } from 'socket.io';

const db = new PrismaClient();
const app = new Elysia();

// Setup Socket.io
const io = new Server(3002, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store pending notifications for users who might not be connected yet
const pendingNotifications = new Map<string, any[]>();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", (phoneNumber) => {
    socket.join(phoneNumber);
    console.log(`User ${phoneNumber} joined their notification room`);

    // Check if there are any pending notifications for this user
    const pending = pendingNotifications.get(phoneNumber);
    if (pending && pending.length > 0) {
      console.log(`Delivering ${pending.length} pending notifications to ${phoneNumber}`);
      pending.forEach(notif => {
        socket.emit("payment_success", notif);
      });
      pendingNotifications.delete(phoneNumber);
    }
  });
});

// Helper function to send notification with retry/queue logic
const sendPaymentNotification = (userPhone: string, data: any) => {
  const room = io.sockets.adapter.rooms.get(userPhone);
  const isConnected = room && room.size > 0;

  if (isConnected) {
    // User is online, send immediately
    io.to(userPhone).emit("payment_success", data);
    console.log(`Immediate notification sent to ${userPhone}`);
  } else {
    // User is offline, save to queue
    console.log(`User ${userPhone} offline. Queuing notification for ${userPhone}`);

    const currentPending = pendingNotifications.get(userPhone) || [];
    if (!currentPending.some(n => n.orderId === data.orderId)) {
      currentPending.push(data);
      pendingNotifications.set(userPhone, currentPending);
    }

    // Also try a few delayed retries in case they are switching app
    [3000, 7000, 15000].forEach(delay => {
      setTimeout(() => {
        const stillPending = pendingNotifications.get(userPhone);
        const isStillNeeded = stillPending && stillPending.some(n => n.orderId === data.orderId);

        if (!isStillNeeded) return;

        const stillRoom = io.sockets.adapter.rooms.get(userPhone);
        if (stillRoom && stillRoom.size > 0) {
          io.to(userPhone).emit("payment_success", data);
          const updated = stillPending.filter(n => n.orderId !== data.orderId);
          if (updated.length === 0) pendingNotifications.delete(userPhone);
          else pendingNotifications.set(userPhone, updated);
          console.log(`Delayed notification sent to ${userPhone} after ${delay}ms`);
        }
      }, delay);
    });
  }
};



const Summ = async () => {
  await db.$executeRaw`
            UPDATE "User"
            SET "totalPoint" = "pointDl" + "pointMk" + "pointSpt" - "usePoint"
          `;
}

const SumLoop = () => {
  Summ()

  setTimeout(() => {
    SumLoop()
  }, 5000)
}

const CleanupOrders = async () => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Find orders that are still unpaid and pending after 5 minutes
    const expiredOrders = await db.order.findMany({
      where: {
        paymentStatus: 'unpaid',
        paymentMethod: 'qr',
        status: 'pending',
        createdAt: {
          lt: fiveMinutesAgo
        }
      }
    });

    if (expiredOrders.length > 0) {
      console.log(`Found ${expiredOrders.length} expired orders to clean up`);
    }

    for (const order of expiredOrders) {
      console.log(`Auto-cancelling expired order: ${order.id}`);
      try {
        await db.$transaction(async (tx) => {
          // 1. Update order status to cancelled
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'cancelled' }
          });

          // 2. Refund points to user
          await tx.user.update({
            where: { phoneNumber: order.userPhone },
            data: {
              usePoint: {
                decrement: order.totalPoints
              }
            }
          });

          // 3. Remove the pending payment lock (คืน lock ราคา)
          await tx.paymentNotification.deleteMany({
            where: {
              orderId: order.id,
              payload: { startsWith: 'PENDING_ORDER_' }
            }
          });
        });

        // 4. Send socket notification
        io.to(order.userPhone).emit("order_cancelled", {
          orderId: order.id,
          message: "ออเดอร์ถูกยกเลิกเนื่องจากเกินเวลาชำระเงิน"
        });

        console.log(`Successfully cancelled order ${order.id} and refunded ${order.totalPoints} points`);
      } catch (error) {
        console.error(`Failed to auto-cancel order ${order.id}:`, error);
      }
    }

    if (expiredOrders.length > 0) {
      await Summ(); // Recalculate total points for all users
    }
  } catch (error) {
    console.error('Error in CleanupOrders:', error);
  }
}

const CleanupLoop = () => {
  CleanupOrders();
  setTimeout(() => {
    CleanupLoop();
  }, 30000); // Run every 30 seconds
}

SumLoop()
CleanupLoop()

app
  .use(cors())
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET || 'super-secret-key'
    })
  )
  .use(staticPlugin())
  .get('/', () => 'Hello Elysia')
  .post('/api/register', async ({ body, set, jwt }: { body: any, set: any, jwt: any }) => {
    try {
      const { name, phoneNumber, mooban } = body;

      if (!phoneNumber) {
        set.status = 400;
        return { message: 'Phone Number is required' };
      }

      const user = await db.user.create({
        data: {
          name,
          phoneNumber,
          pointMk: 0,
          pointSpt: 0,
          pointDl: 0,
          usePoint: 0,
          profileImage: 'default.png',
          mooban: mooban || null
        }
      });

      let created_maekhan = await axios.post(`${store_url.maekhan}/member`, {
        "Id": phoneNumber,
        "Title": 0,
        "FirstName": name,
        "LastName": "",
        "Tel": "",
        "SSN": "",
        "BirthDate": "2026-06-08T13:32:17+00:00",
        "Email": "",
        "Image": "",
        "Address": mooban || "",
        "Remarks": "",
        "Point": 0,
        "Level": 0,
        "ScrapPoint": 0,
        "Expire": null,
        "TaxId": "",
        "LastUpdate": "2026-06-08T13:32:17+00:00",
        "Create": "2026-06-08T13:32:17+00:00",
        "CreateBy": "admin_play2_maekhan",
        "LastUpdateBy": "admin_play2",
        "IsDelete": false,
        "ShippingAddress": "",
        "CreditLimit": 0.00,
        "EntityType": 0
      }).then((res) => {
        return res.data
      })

      let created_sanpatong = await axios.post(`${store_url.sanpatong}/member`, {
        "Id": phoneNumber,
        "Title": 0,
        "FirstName": name,
        "LastName": "",
        "Tel": "",
        "SSN": "",
        "BirthDate": "2026-06-08T13:32:17+00:00",
        "Email": "",
        "Image": "",
        "Address": mooban || "",
        "Remarks": "",
        "Point": 0,
        "Level": 0,
        "ScrapPoint": 0,
        "Expire": null,
        "TaxId": "",
        "LastUpdate": "2026-06-08T13:32:17+00:00",
        "Create": "2026-06-08T13:32:17+00:00",
        "CreateBy": "admin_play2_sanpatong",
        "LastUpdateBy": "admin_play2",
        "IsDelete": false,
        "ShippingAddress": "",
        "CreditLimit": 0.00,
        "EntityType": 0
      }).then((res) => {
        return res.data
      })


      let created_doilor = await axios.post(`${store_url.doilor}/member`, {
        "Id": phoneNumber,
        "Title": 0,
        "FirstName": name,
        "LastName": "",
        "Tel": "",
        "SSN": "",
        "BirthDate": "2026-06-08T13:32:17+00:00",
        "Email": "",
        "Image": "",
        "Address": mooban || "",
        "Remarks": "",
        "Point": 0,
        "Level": 0,
        "ScrapPoint": 0,
        "Expire": null,
        "TaxId": "",
        "LastUpdate": "2026-06-08T13:32:17+00:00",
        "Create": "2026-06-08T13:32:17+00:00",
        "CreateBy": "admin_play2_doilor",
        "LastUpdateBy": "admin_play2",
        "IsDelete": false,
        "ShippingAddress": "",
        "CreditLimit": 0.00,
        "EntityType": 0
      }).then((res) => {
        return res.data
      })

      const token = await jwt.sign({
        phoneNumber: user.phoneNumber,
        role: user.role
      });

      return {
        status: 'success',
        message: 'User registered successfully',
        data: {
          user,
          token
        }
      };
    } catch (error: any) {
      if (error.code === 'P2002') {
        set.status = 400;
        return { message: 'Email or Phone Number already exists' };
      }
      set.status = 500;
      return { message: error.message };
    }
  })
  .post('/api/login', async ({ body, set, jwt }: { body: any, set: any, jwt: any }) => {
    try {
      const { phoneNumber } = body;

      if (!phoneNumber) {
        set.status = 400;
        return { message: 'Phone Number is required' };
      }

      const user = await db.user.findUnique({
        where: { phoneNumber }
      });

      if (!user) {
        set.status = 404;
        return { message: 'User not found' };
      }

      const token = await jwt.sign({
        phoneNumber: user.phoneNumber,
        role: user.role
      });

      return {
        status: 'success',
        message: 'Login successful',
        data: {
          user,
          token
        }
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .get('/api/user/me', async ({ jwt, set, request }: { jwt: any, set: any, request: Request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const user = await db.user.findUnique({
        where: { phoneNumber: payload.phoneNumber }
      });

      if (!user) {
        set.status = 404;
        return { message: 'User not found' };
      }

      return {
        status: 'success',
        data: user
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .post('/api/user/address', async ({ jwt, set, request, body }: { jwt: any, set: any, request: Request, body: any }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const { address, subDistrict, district, province, postalCode, latitude, longitude } = body;

      const user = await db.user.update({
        where: { phoneNumber: payload.phoneNumber },
        data: {
          address,
          subDistrict,
          district,
          province,
          postalCode,
          latitude,
          longitude
        }
      });

      return {
        status: 'success',
        data: user
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  }, {
    body: t.Object({
      address: t.String(),
      subDistrict: t.String(),
      district: t.String(),
      province: t.String(),
      postalCode: t.String(),
      latitude: t.Optional(t.Number()),
      longitude: t.Optional(t.Number())
    })
  })
  .post('/api/user/profile-image', async ({ jwt, set, request, body }: { jwt: any, set: any, request: Request, body: any }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const { image } = body;

      if (!image || !(image instanceof File)) {
        set.status = 400;
        return { message: 'Image is required' };
      }

      const timestamp = Date.now();
      const filename = `profile_${payload.phoneNumber}_${timestamp}.jpg`;

      const buffer = Buffer.from(await image.arrayBuffer());
      const resizedBuffer = await sharp(buffer)
        .resize(400, 400, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer();

      await Bun.write(`public/profiles/${filename}`, resizedBuffer);

      const user = await db.user.update({
        where: { phoneNumber: payload.phoneNumber },
        data: {
          profileImage: filename
        }
      });

      return {
        status: 'success',
        data: user
      };
    } catch (error: any) {
      console.error('Upload profile error:', error);
      set.status = 500;
      return { message: error.message };
    }
  }, {
    body: t.Object({
      image: t.Any()
    })
  })
  .post('/api/user/profile', async ({ jwt, set, request, body }: { jwt: any, set: any, request: Request, body: any }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const { name } = body;

      const user = await db.user.update({
        where: { phoneNumber: payload.phoneNumber },
        data: {
          name
        }
      });

      return {
        status: 'success',
        data: user
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  }, {
    body: t.Object({
      name: t.String()
    })
  })
  .get('/api/products', async ({ set }) => {
    try {
      const products = await db.product.findMany();
      return {
        status: 'success',
        data: products
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .post('/api/products', async ({ body, set, jwt, request }: { body: any, set: any, jwt: any, request: Request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const { name, price, points, category, image } = body;

      let filename = '';
      if (image && image instanceof File) {
        const timestamp = Date.now();

        // Clean product name to be safe for filenames
        const safeProductName = name.toString().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const baseName = safeProductName || 'product';

        filename = `img_${baseName}_${timestamp}.jpg`;

        const buffer = Buffer.from(await image.arrayBuffer());
        const resizedBuffer = await sharp(buffer)
          .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toBuffer();

        await Bun.write(`public/products/${filename}`, resizedBuffer);
      } else if (image && typeof image === 'string') {
        // Handle cases where image might be a URL string (fallback)
        filename = image;
      }

      const product = await db.product.create({
        data: {
          name: name.toString(),
          price: parseInt(price.toString()),
          points: parseInt(points.toString()),
          image: filename,
          category: category.toString()
        }
      });
      return {
        status: 'success',
        data: product
      };
    } catch (error: any) {
      console.error('Create product error:', error);
      set.status = 500;
      return { message: error.message };
    }
  }, {
    body: t.Object({
      name: t.String(),
      price: t.Any(),
      points: t.Any(),
      category: t.String(),
      image: t.Optional(t.Any())
    })
  })
  .delete('/api/products/:id', async ({ params: { id }, set, jwt, request }: { params: { id: string }, set: any, jwt: any, request: Request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const product = await db.product.findUnique({ where: { id } });
      if (!product) {
        set.status = 404;
        return { message: 'Product not found' };
      }

      // Delete local image file if it exists and starts with img_
      if (product.image && product.image.startsWith('img_')) {
        try {
          const { unlink } = require('fs/promises');
          await unlink(`public/products/${product.image}`);
        } catch (err) {
          console.error('Failed to delete product image file:', err);
        }
      }

      await db.product.delete({ where: { id } });

      return {
        status: 'success',
        message: 'Product deleted successfully'
      };
    } catch (error: any) {
      console.error('Delete product error:', error);
      set.status = 500;
      return { message: error.message };
    }
  })
  .post('/api/orders', async ({ body, set, jwt, request }: { body: any, set: any, jwt: any, request: Request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const { totalCash, totalPoints, items, deliveryMethod, paymentMethod, pickupDetails } = body;

      const user = await db.user.findUnique({
        where: { phoneNumber: payload.phoneNumber }
      });

      if (!user) {
        set.status = 404;
        return { message: 'User not found' };
      }

      if (user.totalPoint < totalPoints) {
        set.status = 400;
        return { message: 'Insufficient points' };
      }

      // Find the lowest available unique totalCash amount ONLY for QR orders
      let finalCash = parseFloat(totalCash.toString());
      if (paymentMethod !== 'cod') {
        let increment = 0;
        let isUnique = false;
        const oneHourAgoForUnique = new Date(Date.now() - 60 * 60 * 1000);

        while (!isUnique) {
          const testAmount = parseFloat((finalCash + increment).toFixed(2));
          const existingUnpaidOrder = await db.order.findFirst({
            where: {
              totalCash: testAmount,
              paymentStatus: 'unpaid',
              status: { not: 'cancelled' },
              createdAt: { gte: oneHourAgoForUnique }
            }
          });

          if (existingUnpaidOrder) {
            increment += 0.01;
          } else {
            finalCash = testAmount;
            isUnique = true;
          }
        }
      }

      const result = await db.$transaction(async (tx) => {
        // Create order
        const order = await tx.order.create({
          data: {
            userPhone: user.phoneNumber,
            totalCash: finalCash,
            totalPoints: parseInt(totalPoints.toString()),
            status: 'pending',
            paymentStatus: 'unpaid',
            deliveryMethod: deliveryMethod || 'pickup',
            paymentMethod: paymentMethod || 'qr',
            pickupDetails: pickupDetails || null,
            items: {
              create: items.map((item: any) => ({
                productId: item.id,
                name: item.name,
                price: parseInt(item.price.toString()),
                points: parseInt(item.points.toString()),
                quantity: parseInt(item.quantity.toString())
              }))
            }
          },
          include: {
            items: true
          }
        });

        // Create a temporary lock record ONLY for QR orders
        if (paymentMethod !== 'cod') {
          await tx.paymentNotification.create({
            data: {
              payload: `PENDING_ORDER_${order.id}`,
              amount: finalCash,
              orderId: order.id,
            }
          });
        }

        // Update user's used points
        await tx.user.update({
          where: { phoneNumber: user.phoneNumber },
          data: {
            usePoint: user.usePoint + parseInt(totalPoints.toString())
          }
        });

        return order;
      });

      // Recalculate total points immediately
      await Summ();

      return {
        status: 'success',
        data: result
      };
    } catch (error: any) {
      console.error('--- CREATE ORDER ERROR START ---');
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      if (error.code) console.error('Error Code:', error.code);
      if (error.meta) console.error('Error Meta:', JSON.stringify(error.meta));
      console.error('Stack Trace:', error.stack);
      console.error('--- CREATE ORDER ERROR END ---');

      set.status = 500;
      return { message: error.message || 'เกิดข้อผิดพลาดในการสร้างคำสั่งซื้อ' };
    }
  }, {
    body: t.Object({
      totalCash: t.Any(),
      totalPoints: t.Any(),
      deliveryMethod: t.Optional(t.String()),
      paymentMethod: t.Optional(t.String()),
      pickupDetails: t.Optional(t.String()),
      items: t.Array(t.Object({
        id: t.String(),
        name: t.String(),
        price: t.Any(),
        points: t.Any(),
        quantity: t.Any()
      }))
    })
  })
  .get('/api/orders', async ({ jwt, set, request }: { jwt: any, set: any, request: Request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const orders = await db.order.findMany({
        where: { userPhone: payload.phoneNumber },
        include: { items: true },
        orderBy: { createdAt: 'desc' }
      });

      return {
        status: 'success',
        data: orders
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .patch('/api/orders/:id/cancel', async ({ jwt, set, request, params: { id } }: { jwt: any, set: any, request: Request, params: { id: string } }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { message: 'Invalid token' };
      }

      const order = await db.order.findUnique({
        where: { id },
        include: { items: true }
      });

      if (!order) {
        set.status = 404;
        return { message: 'Order not found' };
      }

      if (order.userPhone !== payload.phoneNumber) {
        set.status = 403;
        return { message: 'Forbidden' };
      }

      if (order.status !== 'pending') {
        set.status = 400;
        return { message: 'Cannot cancel order that is not pending' };
      }

      await db.$transaction(async (tx) => {
        // 1. Update order status to cancelled
        await tx.order.update({
          where: { id },
          data: { status: 'cancelled' }
        });

        // 2. Refund points to user
        await tx.user.update({
          where: { phoneNumber: order.userPhone },
          data: {
            usePoint: {
              decrement: order.totalPoints
            }
          }
        });

        // 3. Remove the pending payment lock if exists
        await tx.paymentNotification.deleteMany({
          where: {
            orderId: order.id,
            payload: { startsWith: 'PENDING_ORDER_' }
          }
        });
      });

      await Summ(); // Recalculate total points

      return {
        status: 'success',
        message: 'Order cancelled successfully'
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .get('/api/admin/orders', async ({ jwt, set, request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const orders = await db.order.findMany({
        include: {
          items: true,
          user: true
        },
        orderBy: { createdAt: 'desc' }
      });

      return {
        status: 'success',
        data: orders
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .patch('/api/admin/orders/:id/status', async ({ params: { id }, body, set, jwt, request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const { status } = body;

      const currentOrder = await db.order.findUnique({ where: { id } });
      if (!currentOrder) {
        set.status = 404;
        return { message: 'Order not found' };
      }

      const updateData: any = { status };

      // If admin completes a COD order, mark it as paid
      if (status === 'completed' && currentOrder.paymentMethod === 'cod') {
        updateData.paymentStatus = 'paid';
      }

      const order = await db.order.update({
        where: { id },
        data: updateData,
        include: { items: true }
      });
      return {
        status: 'success',
        data: order
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  }, {
    body: t.Object({
      status: t.String()
    })
  })
  .get('/api/admin/stats', async ({ set, jwt, request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Get orders from today (not cancelled)
      const todayOrders = await db.order.findMany({
        where: {
          createdAt: {
            gte: today,
            lt: tomorrow
          },
          status: {
            not: 'cancelled'
          }
        }
      });

      const dailySales = todayOrders.reduce((acc, order) => acc + order.totalCash, 0);

      // Get new (pending) orders count
      const dailyOrders = await db.order.count({
        where: {
          createdAt: {
            gte: today,
            lt: tomorrow
          },
          status: 'pending'
        }
      });

      // Get total users for a bonus stat
      const totalUsers = await db.user.count();

      return {
        status: 'success',
        data: {
          dailySales,
          dailyOrders,
          totalUsers
        }
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .get('/api/admin/users', async ({ set, jwt, request }) => {
    try {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { message: 'Unauthorized' };
      }

      const token = authHeader.split(' ')[1];
      const payload = await jwt.verify(token);

      if (!payload || payload.role !== 1) {
        set.status = 403;
        return { message: 'Forbidden: Admin access required' };
      }

      const users = await db.user.findMany({
        orderBy: { phoneNumber: 'asc' }
      });
      return {
        status: 'success',
        data: users
      };
    } catch (error: any) {
      set.status = 500;
      return { message: error.message };
    }
  })
  .get('/test', async ({ set }) => {
    return { status: 200, msg: "Ok" }
  })
  .post("/sync", async ({ set, body }: { body: any, set: any }) => {
    try {
      const { sync_new_data, store } = body;


      if (store === 'maekhan') {
        sync_new_data.map(async (item: any) => {
          let synced = await db.user.update({
            where: {
              phoneNumber: item.MemberId
            },
            data: {
              pointMk: item.NewPoint

            }
          })
        })
      } else if (store === "doilor") {
        sync_new_data.map(async (item: any) => {
          let synced = await db.user.update({
            where: {
              phoneNumber: item.MemberId
            },
            data: {
              pointDl: item.NewPoint
            }
          })
        })
      } else if (store === "sanpatong") {
        sync_new_data.map(async (item: any) => {
          let synced = await db.user.update({
            where: {
              phoneNumber: item.MemberId
            },
            data: {
              pointSpt: item.NewPoint
            }
          })
        })
      }

      console.log("Sync Data!")


    } catch (err) {
      console.log(err)
    }
  },)
  .post("/webhook", async ({ body, set }: { body: any, set: any }) => {
    try {
      console.log("--- WEBHOOK DEBUG START ---");
      console.log("Raw Webhook Body:", JSON.stringify(body));

      const dataString = typeof body === 'string' ? body : (body.text || JSON.stringify(body));
      console.log("Processed Data String:", dataString);

      // 1. Extract amount using a more targeted regex
      // We want to find the number followed by " บ." or just the last number that looks like a price
      const amountMatch = dataString.match(/(\d{1,3}(,\d{3})*(\.\d+)?)/g);
      if (!amountMatch) {
        console.log("ERROR: No numbers found in text");
        return { status: 'error', message: 'Amount not found' };
      }

      // Often the price is the largest number or the one near the end. 
      // Let's log all matches to see what we're dealing with.
      console.log("All numeric matches:", amountMatch);

      // For K SHOP-ได้รับชำระเงิน 1.15 บ. -> 1.15 is the first/main match
      const amount = parseFloat(amountMatch[0].replace(/,/g, ''));
      console.log("Extracted Amount:", amount);

      // 2. Find the 'PENDING' lock for this amount
      // Increase window to 2 hours just in case of slow bank notifications
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      console.log("Searching for PENDING lock with amount:", amount, "since:", twoHoursAgo.toISOString());

      const pendingLock = await db.paymentNotification.findFirst({
        where: {
          amount: amount,
          payload: { startsWith: 'PENDING_ORDER_' },
          createdAt: { gte: twoHoursAgo }
        },
        include: {
          order: true
        },
        orderBy: { createdAt: 'desc' }
      });

      if (pendingLock && pendingLock.orderId) {
        // 3. Check if THIS SPECIFIC order has already used this bank notification payload
        // This prevents the exact same webhook call from being processed twice for the same order
        const alreadyLinked = await db.paymentNotification.findFirst({
          where: {
            orderId: pendingLock.orderId,
            payload: dataString,
            NOT: {
              payload: { startsWith: 'PENDING_ORDER_' }
            }
          }
        });

        if (alreadyLinked) {
          console.log("INFO: This bank notification already processed for Order", pendingLock.orderId);
          return { status: 'ignored', message: 'Already processed for this order' };
        }

        console.log("MATCH FOUND: Order ID", pendingLock.orderId, "for User", pendingLock.order?.userPhone);
        const orderId = pendingLock.orderId;
        const userPhone = pendingLock.order?.userPhone;

        // 4. Update order and release lock
        await db.$transaction([
          db.order.update({
            where: { id: orderId },
            data: { paymentStatus: 'paid' }
          }),
          db.paymentNotification.delete({
            where: { id: pendingLock.id }
          }),
          db.paymentNotification.create({
            data: {
              payload: dataString,
              amount: amount,
              orderId: orderId
            }
          })
        ]);

        console.log("SUCCESS: Order updated to paid and lock released");

        if (userPhone) {
          sendPaymentNotification(userPhone, {
            orderId: orderId,
            amount: amount,
            message: "ชำระเงินสำเร็จแล้ว!"
          });
        }

        return { status: 'success', message: `Order ${orderId} marked as paid` };
      } else {
        console.log("NO MATCH: No pending lock found for amount", amount);

        // Also log any UNPAID orders for this amount to see if a lock was missing
        const unpaidOrder = await db.order.findFirst({
          where: { totalCash: amount, paymentStatus: 'unpaid' }
        });
        if (unpaidOrder) {
          console.log("NOTE: Found an UNPAID order with this amount but NO pending lock record existed!");
        }

        await db.paymentNotification.create({
          data: {
            payload: dataString,
            amount: amount,
          }
        });
        return { status: 'recorded', message: 'Payment recorded but no matching order found' };
      }
    } catch (error: any) {
      console.error('CRITICAL Webhook error:', error);
      set.status = 500;
      return { status: 'error', message: error.message };
    } finally {
      console.log("--- WEBHOOK DEBUG END ---");
    }
  })
  .listen(3001);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
