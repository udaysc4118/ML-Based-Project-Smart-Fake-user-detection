require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'Frontend')));

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const hasSupabase = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = hasSupabase
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  })
  : null;

const pendingRequests = new Map();
const otpCooldowns = new Map();
// pendingRequests[email] = { action: 'signup'|'reset', username, passwordHash, verified, code }

const resend = new Resend(process.env.RESEND_API_KEY);

console.log('Resend email service configured');
const fallbackUsers = [
  { email: 'user@example.com', passwordHash: bcrypt.hashSync('user123', 10), role: 'user', username: 'demoUser' }
];

let server;

function shutdownServer(reason) {
  if (reason) {
    console.log(reason);
  }

  if (server) {
    server.close(() => process.exit(0));
    return;
  }

  process.exit(0);
}

function enableTerminalStopCommand() {
  if (!process.stdin.isTTY) {
    return;
  }

  const terminalInput = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  terminalInput.on('line', (line) => {
    const command = line.trim().toLowerCase();

    if (command === 'stop' || command === 'exit' || command === 'quit') {
      terminalInput.close();
      shutdownServer('Stop command received. Shutting down backend...');
    }
  });

  process.on('SIGINT', () => {
    terminalInput.close();
    shutdownServer('SIGINT received. Shutting down backend...');
  });

  process.on('SIGTERM', () => {
    terminalInput.close();
    shutdownServer('SIGTERM received. Shutting down backend...');
  });
}

function db(table) {
  if (!supabase) {
    throw new Error('Supabase is not configured');
  }

  return supabase.from(table);
}

async function getUserByEmail(email) {
  if (supabase) {
    const { data, error } = await db('app_users')
      .select('id,email,username,password_hash,role')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  return fallbackUsers.find((user) => user.email === email) || null;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    supabase: hasSupabase,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, loginType } = req.body || {};

    console.log('Login attempt:', { email, loginType });

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Missing credentials' });
    }

    if (loginType === 'admin') {
      if (email === 'admin' && password === 'admin123') {
        console.log('Admin login successful');
        return res.json({ success: true, role: 'admin' });
      }

      console.log('Admin login failed for', email);
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }

    const found = await getUserByEmail(email);
    if (found) {
      const passwordHash = found.password_hash || found.passwordHash;
      const matches = passwordHash && await bcrypt.compare(password, passwordHash);

      if (matches) {
        console.log('User login successful:', email);

        // Update login count & last login timestamp in Supabase
        if (supabase) {
          try {
            const currentLogins = Number(found.login_count || 0) + 1;
            await db('app_users')
              .update({ login_count: currentLogins, last_login: new Date().toISOString() })
              .eq('email', email);
          } catch (e) {
            console.error('Failed to update login_count in Supabase:', e.message);
          }
        }

        return res.json({
          success: true,
          role: found.role || 'user',
          username: found.username || email.split('@')[0],
          user: {
            id: found.id,
            email: found.email,
            username: found.username,
            name: found.name || found.username,
            status: found.status || 'Active',
            loginCount: (found.login_count || 0) + 1,
            totalTimeSpent: found.total_time_spent || 0,
            warnings: found.warnings || []
          }
        });
      }
    }

    console.log('User login failed (invalid credentials):', email);
    return res.status(401).json({ success: false, message: 'Invalid user credentials' });
  } catch (err) {
    console.error('Error in /api/login:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/forgot', async (req, res) => {
  let { email, username, newPassword } = req.body || {};
  email = (email || '').toString().trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  const action = newPassword ? 'signup' : 'reset';
  const passwordHash = newPassword ? await bcrypt.hash(newPassword, 10) : null;
  const cooldownKey = `${email}:${action}`;
  const now = Date.now();
  const cooldownEntry = otpCooldowns.get(cooldownKey);

  if (cooldownEntry && now < cooldownEntry.until) {
    console.log('Duplicate OTP request ignored for', email, 'within cooldown window');
    return res.json({ success: true, duplicate: true, message: 'OTP already sent recently' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpCooldowns.set(cooldownKey, { until: now + 30000 });

  // Store pending request in memory first
  pendingRequests.set(email, {
    action,
    username: username || email,
    passwordHash,
    verified: false,
    code
  });

  // Persist to DB if available
  if (supabase) {
    const { error } = await db('otp_requests').upsert({
      email,
      code,
      username: username || email,
      password_hash: passwordHash,
      action,
      verified: false
    });

    if (error) {
      pendingRequests.delete(email);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  // Send Email with Resend
  try {
    const { data, error } = await resend.emails.send({
      from: 'RecomAI <onboarding@fakeuserdetect.me>',
      to: [email],
      subject: action === 'signup'
        ? 'Welcome to RecomAI - Verify Your Email'
        : 'RecomAI - Password Reset OTP',

      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">

        <h2 style="color: #6c5ce7; text-align: center;">
          RecomAI
        </h2>

        <p style="font-size: 16px; color: #333;">
          Hello ${username || ''},
        </p>

        <p style="font-size: 16px; color: #333;">
          ${action === 'signup'
          ? 'Thank you for signing up! Please use the OTP below to verify your email address.'
          : 'We received a request to reset your password. Use the OTP below to proceed.'
        }
        </p>

        <div style="text-align: center; margin: 30px 0;">
          <span style="
            display: inline-block;
            font-size: 24px;
            font-weight: bold;
            background: #f1f3f8;
            padding: 15px 25px;
            border-radius: 8px;
            letter-spacing: 5px;
            color: #172033;
          ">
            ${code}
          </span>
        </div>

        <p style="font-size: 14px; color: #777; text-align: center;">
          This code will expire in 10 minutes.
        </p>

        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />

        <p style="font-size: 12px; color: #999; text-align: center;">
          If you didn't request this, please ignore this email.
        </p>

      </div>
    `
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log(
      'Email sent successfully to',
      email,
      'messageId:',
      data?.id || 'unknown'
    );

  } catch (mailErr) {

    console.error(
      'Error sending email to',
      email,
      mailErr?.message || mailErr
    );

    otpCooldowns.delete(cooldownKey);
    pendingRequests.delete(email);

    if (supabase) {
      await db('otp_requests').delete().eq('email', email);
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to send verification email'
    });
  }

  console.log('OTP generated for', email, code);

  return res.json({ success: true });
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    let { email, code } = req.body || {};

    email = (email || '').toString().trim().toLowerCase();
    code = (code || '').toString().trim();

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: 'Email and code are required'
      });
    }

    let pending = pendingRequests.get(email);

    // Recover OTP from Supabase if server restarted/slept
    if (!pending && supabase) {
      const { data, error } = await db('otp_requests')
        .select('email,code,username,password_hash,action,verified')
        .eq('email', email)
        .maybeSingle();

      if (error) {
        console.error('OTP recovery error:', error.message);
        return res.status(500).json({
          success: false,
          message: 'Unable to verify OTP'
        });
      }

      if (data) {
        pending = {
          action: data.action || 'reset',
          username: data.username || email,
          passwordHash: data.password_hash || null,
          verified: Boolean(data.verified),
          code: String(data.code || '')
        };

        pendingRequests.set(email, pending);
      }
    }

    if (!pending) {
      return res.status(400).json({
        success: false,
        message: 'No pending request found. Please request a new OTP.'
      });
    }

    if (pending.code !== code) {
      return res.status(400).json({
        success: false,
        message: 'Invalid code'
      });
    }

    pending.verified = true;
    pendingRequests.set(email, pending);

    if (supabase) {
      const { error } = await db('otp_requests')
        .update({ verified: true })
        .eq('email', email);

      if (error) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }
    }

    // Signup verification
    if (pending.action === 'signup') {

      if (!pending.passwordHash) {
        return res.status(400).json({
          success: false,
          message: 'Signup information is missing. Please start signup again.'
        });
      }

      if (supabase) {
        const { error: upsertError } = await db('app_users').upsert({
          email,
          username: pending.username,
          password_hash: pending.passwordHash,
          role: 'user'
        }, { onConflict: 'email' });

        if (upsertError) {
          return res.status(400).json({
            success: false,
            message: upsertError.message
          });
        }

        await db('otp_requests')
          .delete()
          .eq('email', email);

        pendingRequests.delete(email);

        return res.json({
          success: true,
          action: 'signup'
        });
      }
    }

    // Forgot-password verification
    return res.json({
      success: true,
      action: pending.action
    });

  } catch (err) {
    console.error(
      'Error in /api/verify-otp:',
      err && err.message ? err.message : err
    );

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body || {};

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email and new password are required' });
  }

  const pending = pendingRequests.get(email);
  if (!pending || pending.action !== 'reset' || !pending.verified) {
    return res.status(400).json({ success: false, message: 'OTP verification required first' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  if (supabase) {
    const { error } = await db('app_users').upsert({
      email,
      username: pending.username,
      password_hash: passwordHash,
      role: 'user'
    }, { onConflict: 'email' });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    await db('otp_requests').delete().eq('email', email);
  } else {
    const user = fallbackUsers.find((item) => item.email === email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.passwordHash = passwordHash;
  }

  pendingRequests.delete(email);
  return res.json({ success: true });
});

/* =====================================================
   PRODUCTS API
===================================================== */
let storeProducts = [
  { id: 1, name: "Wireless AI Headphones", category: "Audio", price: 2499, oldPrice: 3999, rating: 4.8, reviews: 1240, discount: "37% OFF", image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e", description: "Intelligent noise cancelling headphones with real-time sound optimization." },
  { id: 2, name: "Smart Watch Ultra", category: "Electronics", price: 4999, oldPrice: 7999, rating: 4.6, reviews: 890, discount: "38% OFF", image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30", description: "Advanced fitness and health tracker with AMOLED display." },
  { id: 3, name: "MacBook Pro M2", category: "Laptops", price: 119900, oldPrice: 129900, rating: 4.9, reviews: 3420, discount: "7% OFF", image: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8", description: "Apple M2 chip laptop designed for developers and creators." },
  { id: 4, name: "Nike Air Max 270", category: "Fashion", price: 6995, oldPrice: 8995, rating: 4.7, reviews: 1980, discount: "22% OFF", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff", description: "Premium stylish sneaker for sports and outdoor lifestyle." },
  { id: 5, name: "Ergonomic Gym Backpack", category: "Backpacks", price: 1899, oldPrice: 2999, rating: 4.5, reviews: 670, discount: "36% OFF", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62", description: "Water resistant backpack with dedicated laptop and gym gear compartments." },
  { id: 6, name: "Pro Dumbbell Set 20kg", category: "GYM", price: 3499, oldPrice: 4999, rating: 4.6, reviews: 430, discount: "30% OFF", image: "https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2", description: "Adjustable cast iron dumbbells for home workouts." },
  { id: 7, name: "Dell XPS 15", category: "Laptops", price: 134990, oldPrice: 149990, rating: 4.7, reviews: 512, discount: "10% OFF", image: "https://images.unsplash.com/photo-1593642632823-8f785ba67e45", description: "Reliable performance laptop suitable for students and professionals." },
  { id: 8, name: "Adidas Running Shoes", category: "Fashion", price: 5499, oldPrice: 6999, rating: 4.4, reviews: 2876, discount: "21% OFF", image: "https://images.unsplash.com/photo-1556906781-9a412961c28c", description: "Lightweight Adidas running shoes designed for daily training." }
];

app.get('/api/products', (_req, res) => {
  res.json({ success: true, products: storeProducts });
});

app.post('/api/products', (req, res) => {
  try {
    const product = req.body;
    if (!product || !product.name || !product.price) {
      return res.status(400).json({ success: false, message: 'Invalid product details' });
    }
    const newProduct = {
      id: product.id || Date.now(),
      name: product.name,
      category: product.category || 'General',
      price: Number(product.price),
      oldPrice: Number(product.oldPrice || product.price),
      rating: Number(product.rating || 4.5),
      reviews: Number(product.reviews || 0),
      discount: product.discount || '10% OFF',
      image: product.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30',
      description: product.description || product.name
    };
    storeProducts.unshift(newProduct);
    res.json({ success: true, product: newProduct });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  storeProducts = storeProducts.filter(p => p.id !== id);
  res.json({ success: true, message: 'Product deleted successfully' });
});

/* =====================================================
   USER MANAGEMENT & WARNING API
===================================================== */
let backendUsersList = [
  { id: 'usr_101', name: 'Uday Chaudhari', email: 'uday1024@gmail.com', username: 'uday1024', mlStatus: 'Genuine', trustScore: 94, loginCount: 18, totalTimeSpent: 14200, status: 'Active', warnings: [] },
  { id: 'usr_102', name: 'Rahul Sharma', email: 'rahul884@gmail.com', username: 'rahul884', mlStatus: 'Genuine', trustScore: 91, loginCount: 24, totalTimeSpent: 21500, status: 'Active', warnings: [] },
  { id: 'usr_103', name: 'Amit Mehta', email: 'amit447@gmail.com', username: 'amit447', mlStatus: 'Suspicious', trustScore: 61, loginCount: 9, totalTimeSpent: 5800, status: 'Active', warnings: [] },
  { id: 'usr_104', name: 'Vikram Kumar', email: 'vikram7788@gmail.com', username: 'vikram7788', mlStatus: 'Fake User', trustScore: 18, loginCount: 31, totalTimeSpent: 34000, status: 'Blocked', warnings: [] }
];

/* =====================================================
   USER MANAGEMENT & WARNING API (SUPABASE CONNECTED)
===================================================== */
app.get('/api/admin/users', async (_req, res) => {
  try {
    if (supabase) {
      const { data, error } = await db('app_users')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        const mappedUsers = data.map(u => ({
          id: u.id,
          name: u.name || u.username || u.email.split('@')[0],
          email: u.email,
          username: u.username || u.email.split('@')[0],
          role: u.role || 'user',
          status: u.status || 'Active',
          loginCount: u.login_count || 1,
          totalTimeSpent: u.total_time_spent || 0,
          mlStatus: u.ml_status || 'Genuine',
          trustScore: u.trust_score || 95,
          createdAt: u.created_at ? new Date(u.created_at).getTime() : Date.now(),
          lastLogin: u.last_login ? new Date(u.last_login).getTime() : Date.now(),
          warnings: u.warnings || []
        }));
        return res.json({ success: true, users: mappedUsers, source: 'supabase' });
      }
    }

    return res.json({ success: true, users: backendUsersList, source: 'fallback' });
  } catch (err) {
    console.error('Error fetching users from Supabase:', err.message);
    res.json({ success: true, users: backendUsersList, source: 'fallback' });
  }
});

app.post('/api/admin/users/block', async (req, res) => {
  try {
    const { email, userId, status } = req.body || {};
    let newStatus = status;

    if (supabase) {
      const { data: user } = await db('app_users')
        .select('id,email,status')
        .or(`id.eq.${userId},email.eq.${email}`)
        .maybeSingle();

      if (user) {
        newStatus = status || (user.status === 'Blocked' ? 'Active' : 'Blocked');
        const { error } = await db('app_users')
          .update({ status: newStatus })
          .eq('id', user.id);

        if (error) throw error;
        return res.json({ success: true, status: newStatus, userId: user.id });
      }
    }

    const fallbackUser = backendUsersList.find(u => u.id === userId || u.email === email);
    if (fallbackUser) {
      fallbackUser.status = status || (fallbackUser.status === 'Blocked' ? 'Active' : 'Blocked');
      return res.json({ success: true, status: fallbackUser.status });
    }
    res.status(404).json({ success: false, message: 'User not found' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/warn', async (req, res) => {
  try {
    const { userId, email, message, severity } = req.body || {};
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });

    const newWarning = {
      id: 'warn_' + Date.now(),
      message: message.trim(),
      severity: severity || 'Caution',
      timestamp: Date.now(),
      read: false
    };

    if (supabase) {
      const { data: user } = await db('app_users')
        .select('id,email,warnings')
        .or(`id.eq.${userId},email.eq.${email}`)
        .maybeSingle();

      if (user) {
        const currentWarnings = user.warnings || [];
        currentWarnings.unshift(newWarning);
        const { error } = await db('app_users')
          .update({ warnings: currentWarnings })
          .eq('id', user.id);

        if (error) throw error;
        return res.json({ success: true, warning: newWarning });
      }
    }

    const fallbackUser = backendUsersList.find(u => u.id === userId || u.email === email);
    if (fallbackUser) {
      if (!fallbackUser.warnings) fallbackUser.warnings = [];
      fallbackUser.warnings.unshift(newWarning);
      return res.json({ success: true, warning: newWarning });
    }
    res.status(404).json({ success: false, message: 'User not found' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users/usage', async (req, res) => {
  try {
    const { email, seconds } = req.body || {};
    if (!email || !seconds) return res.status(400).json({ success: false });

    if (supabase) {
      const { data: user } = await db('app_users')
        .select('id,total_time_spent')
        .eq('email', email)
        .maybeSingle();

      if (user) {
        const newTotal = (user.total_time_spent || 0) + Number(seconds);
        await db('app_users')
          .update({ total_time_spent: newTotal, last_login: new Date().toISOString() })
          .eq('id', user.id);
        return res.json({ success: true, totalTimeSpent: newTotal });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

enableTerminalStopCommand();

server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(hasSupabase ? 'Supabase table mode enabled' : 'Supabase env not configured, using local fallback mode');
});
