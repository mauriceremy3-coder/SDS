(function () {
  const OWNER_SESSION_KEY = 'schoolfinder_owner_session_v1';
  const OWNER_PROFILE_KEY = 'schoolfinder_owner_profile_v1';
  const OWNER_INQUIRY_KEY = 'schoolfinder_owner_inquiries_v1';
  const REMEMBER_SESSION_KEY = 'schoolfinder_remember_me_v1';
  const authStorage = {
    getItem(key) {
      const storage = localStorage.getItem(REMEMBER_SESSION_KEY) === 'false' ? sessionStorage : localStorage;
      return storage.getItem(key);
    },
    setItem(key, value) {
      const remember = localStorage.getItem(REMEMBER_SESSION_KEY) !== 'false';
      const storage = remember ? localStorage : sessionStorage;
      const otherStorage = remember ? sessionStorage : localStorage;
      otherStorage.removeItem(key);
      storage.setItem(key, value);
    },
    removeItem(key) {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    },
  };
  const portalConfig = {
    url: window.SDS_SUPABASE_URL || '',
    anonKey: window.SDS_SUPABASE_ANON_KEY || '',
  };

  let supabase = null;
  let verifiedSession = null;
  if (window.supabase && portalConfig.url && portalConfig.anonKey) {
    supabase = window.supabase.createClient(portalConfig.url, portalConfig.anonKey, {
      auth: { storage: authStorage },
    });
  }

  function readLocalValue(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn('Could not read local portal data:', error);
      return fallback;
    }
  }

  function writeLocalValue(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('Could not save local portal data:', error);
      return false;
    }
  }

  function getCurrentOwnerSession() {
    return verifiedSession;
  }

  function saveCurrentOwnerSession(value) {
    writeLocalValue(OWNER_SESSION_KEY, value);
  }

  function clearCurrentOwnerSession() {
    localStorage.removeItem(OWNER_SESSION_KEY);
    localStorage.removeItem(OWNER_PROFILE_KEY);
    localStorage.removeItem(OWNER_INQUIRY_KEY);
  }

  function getStoredSchoolProfile() {
    return readLocalValue(OWNER_PROFILE_KEY, null);
  }

  function setStoredSchoolProfile(profile) {
    writeLocalValue(OWNER_PROFILE_KEY, profile);
  }

  function getStoredInquiries() {
    return readLocalValue(OWNER_INQUIRY_KEY, []);
  }

  function setStoredInquiries(list) {
    writeLocalValue(OWNER_INQUIRY_KEY, list);
  }

  function userIsAdmin(user) {
    return user?.role === 'admin';
  }

  async function refreshSupabaseSession() {
    if (!supabase) return null;
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('Supabase auth session error:', error);
      return null;
    }
    if (!session) {
      return null;
    }
    const accountProfile = await fetchAccountProfile(session.user.id);
    if (!accountProfile) {
      await supabase.auth.signOut();
      verifiedSession = null;
      throw new Error('Your account profile is missing. Please contact the platform administrator.');
    }
    const schoolProfile = await fetchProfileForOwner(session.user.id);
    const userDetails = {
      id: session.user.id,
      email: session.user.email,
      name: accountProfile.full_name || 'School owner',
      schoolName: schoolProfile?.school_name || accountProfile.school_name || '',
      phone: accountProfile.phone || '',
      district: schoolProfile?.district || accountProfile.district || '',
      schoolType: schoolProfile?.school_type || accountProfile.school_type || '',
      role: accountProfile.role,
    };
    verifiedSession = userDetails;
    saveCurrentOwnerSession(userDetails);
    return userDetails;
  }

  async function fetchAccountProfile(ownerId) {
    if (!supabase || !ownerId) return null;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, school_name, district, school_type, role')
      .eq('id', ownerId)
      .maybeSingle();
    if (error) {
      console.error('Could not load the authenticated account role:', error);
      throw new Error('Unable to verify your account permissions. Please try again.');
    }
    return data;
  }

  async function fetchProfileForOwner(ownerId) {
    if (!supabase || !ownerId) {
      return getStoredSchoolProfile();
    }
    const { data, error } = await supabase
      .from('school_profiles')
      .select('*')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('Could not load school profile from Supabase:', error);
      return getStoredSchoolProfile();
    }
    return data || getStoredSchoolProfile();
  }

  function setAuthFieldError(form, name, message) {
    const field = form.elements[name];
    if (!field) return;
    field.setAttribute('aria-invalid', message ? 'true' : 'false');
    const errorNode = field.closest('label')?.querySelector('.er');
    if (errorNode) errorNode.textContent = message;
  }

  function validateAuthForm(form, registration = false) {
    let valid = true;
    [...form.querySelectorAll('[required]')].forEach((field) => {
      const name = field.name;
      const value = String(field.value || '').trim();
      let message = '';
      if (field.type === 'checkbox' && !field.checked) {
        message = 'Please accept the terms to continue.';
      } else if (!value) {
        message = 'This field is required.';
      } else if (field.type === 'email' && !/^\S+@\S+\.\S+$/.test(value)) {
        message = 'Enter a valid email address.';
      } else if (name === 'phone' && !/^\+?[0-9\s()\-]{9,18}$/.test(value)) {
        message = 'Enter a valid phone number.';
      } else if (name === 'password' && value.length < 8) {
        message = 'Use at least 8 characters.';
      }
      setAuthFieldError(form, name, message);
      if (message) valid = false;
    });

    if (registration) {
      const password = String(form.elements.password.value || '');
      const confirm = String(form.elements.confirm.value || '');
      const confirmationError = password !== confirm ? 'Passwords do not match.' : '';
      setAuthFieldError(form, 'confirm', confirmationError);
      if (confirmationError) valid = false;
    }

    const errorNode = document.getElementById('owner-auth-error');
    if (errorNode) errorNode.textContent = valid ? '' : 'Please review the highlighted fields and try again.';
    return valid;
  }

  async function fetchInquiriesForOwner(ownerId) {
    if (!supabase || !ownerId) {
      return getStoredInquiries();
    }
    const { data, error } = await supabase
      .from('school_inquiries')
      .select('*')
      .eq('school_owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('Could not load inquiries from Supabase:', error);
      return getStoredInquiries();
    }
    return Array.isArray(data) ? data : [];
  }

  async function fetchAllProfilesForAdmin() {
    if (!supabase) {
      const profile = getStoredSchoolProfile();
      return profile ? [profile] : [];
    }
    const current = getCurrentOwnerSession();
    if (!current || !userIsAdmin(current)) {
      return [];
    }
    const { data, error } = await supabase.from('school_profiles').select('*').order('updated_at', { ascending: false });
    if (error) {
      console.warn('Could not load profiles for admin review:', error);
      return [];
    }
    return data || [];
  }

  function getProfileStatusText(status) {
    if (!status) return 'Draft';
    const map = {
      draft: 'Draft',
      pending_verification: 'Pending Verification',
      approved: 'Approved',
      rejected: 'Rejected',
    };
    return map[status] || String(status).replace(/_/g, ' ');
  }

  function renderOwnerShell(title, subtitle, content) {
    const session = getCurrentOwnerSession();
    const schoolName = session?.schoolName || 'School owner';
    const adminLink = session && userIsAdmin(session) ? '<a href="#/owner-admin">Admin reviews</a>' : '';
    return `
      <section class="ph"><div class="w"><h1>${escapeHtml(title)}</h1>${subtitle ? `<p style="opacity:.85;margin-top:8px">${escapeHtml(subtitle)}</p>` : ''}</div></section>
      <section class="sec" style="padding-top:32px">
        <div class="w">
          <div style="display:grid;gap:20px">
            <div class="ownnote">${supabase ? 'Supabase-connected portal. Email verification is managed by Supabase Auth when enabled for your project.' : 'Local browser mode is active. Configure Supabase to enable true accounts, email verification, and secure shared data.'}</div>
            <div class="db">
              <nav class="sb">
                <b style="margin-bottom:10px">${escapeHtml(schoolName)} · Owner</b>
                <a href="#/owner-dashboard">Overview</a>
                <a href="#/owner-profile">School Profile</a>
                <a href="#/owner-vacancies">Vacancies</a>
                <a href="#/owner-inquiries">Inquiries</a>
                ${adminLink}
                <a href="#/owner-settings">Account Settings</a>
                <a href="#/owner-logout" data-owner-logout>Logout</a>
              </nav>
              <div style="padding:24px;display:grid;gap:20px;align-content:start">${content}</div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function ownerRouteGuard() {
    const session = getCurrentOwnerSession();
    if (!session || !supabase) {
      location.hash = '#/owner-login';
      return null;
    }
    return session;
  }

  const passwordField = (label, name, autocomplete = 'new-password') => `
    <label>${label}
      <span class="row" style="gap:10px;align-items:center">
        <input class="f" name="${name}" type="password" minlength="8" required autocomplete="${autocomplete}">
        <button type="button" class="b o" data-show-password="${label.toLowerCase()}" aria-label="Show ${label.toLowerCase()}" aria-pressed="false">Show</button>
      </span>
      <span class="er"></span>
    </label>
  `;

  const ownerRegister = () => `
    <section class="sec">
      <div class="w auth-shell">
        <form class="cd auth-layout" id="owner-register-form" novalidate>
          <aside class="auth-aside">
            <div><p class="ey">SDS · SCHOOL PARTNERS</p><h2>Bring your school into the directory.</h2><p>Connect with families and help students find the right next step in their education.</p></div>
            <ul><li><span>✓</span> Create a verified owner account</li><li><span>✓</span> Manage your school listing</li><li><span>✓</span> Respond to inquiries</li></ul>
          </aside>
          <div class="auth-form">
            <div><h2>Create a school owner account</h2><p class="m">Set up your profile to register your school.</p></div>
            <div class="auth-account-note">${supabase ? 'Your account is securely managed through Supabase Auth. Email verification may be required.' : 'Account access is not configured yet. Connect Supabase to enable secure registration.'} Parent and student accounts are not available in this portal yet; administrator accounts are provisioned by SDS.</div>
            <div class="authgrid">
              <label>Account type<select class="f" name="accountType" required><option value="school_owner">School Owner</option><option value="parent" disabled>Parent — coming soon</option><option value="student" disabled>Student — coming soon</option></select><span class="er"></span></label>
              <label>Full name<input class="f" name="name" required autocomplete="name"><span class="er"></span></label>
              <label>Email address<input class="f" name="email" type="email" required autocomplete="email" aria-describedby="owner-email-note"><span class="er"></span><span class="m" id="owner-email-note">Used for sign-in and school contact.</span></label>
              <label>Phone number<input class="f" name="phone" type="tel" required autocomplete="tel" placeholder="+250 7XX XXX XXX" aria-describedby="owner-phone-note"><span class="er"></span><span class="m" id="owner-phone-note">Used as the school contact number.</span></label>
              <label>School name<input class="f" name="schoolName" required autocomplete="organization"><span class="er"></span></label>
              <label>District<input class="f" name="district" required autocomplete="address-level2" placeholder="e.g. Gasabo"><span class="er"></span></label>
              <label>School type<select class="f" name="schoolType" required><option value="">Select type</option><option>Public</option><option>Private</option></select><span class="er"></span></label>
              <label>Role / position<input class="f" name="position" required placeholder="Head teacher / owner / registrar"><span class="er"></span></label>
              ${passwordField('Password', 'password')}
              ${passwordField('Confirm password', 'confirm')}
            </div>
            <label class="auth-check"><input type="checkbox" name="terms" required><span>I agree to the <a href="#/terms">Terms of Service</a> and understand how SDS uses my account information.<span class="er"></span></span></label>
            <div class="formactions">
              <button class="b pu" data-auth-submit>Create Account</button>
              <span class="auth-links">Already registered? <a href="#/owner-login">Login</a></span>
            </div>
            <p class="er auth-message" id="owner-auth-error" role="alert" aria-live="polite"></p>
          </div>
        </form>
      </div>
    </section>
  `;

  const ownerLogin = () => `
    <section class="sec">
      <div class="w auth-shell">
        <form class="cd auth-layout" id="owner-login-form" novalidate>
          <aside class="auth-aside">
            <div><p class="ey">SDS · SCHOOL PARTNERS</p><h2>Welcome back to your school community.</h2><p>Sign in to keep your school information and conversations up to date.</p></div>
            <ul><li><span>✓</span> Manage your school profile</li><li><span>✓</span> Update vacancies</li><li><span>✓</span> Follow up on inquiries</li></ul>
          </aside>
          <div class="auth-form">
            <div><h2>Sign in to SDS</h2><p class="m">Use your registered school portal account.</p></div>
            <div class="auth-account-note">${supabase ? 'Secure sign-in is provided by Supabase Auth.' : 'Authentication is not configured yet. Connect Supabase to enable sign-in.'} Parent/student sign-in is not available in this portal.</div>
            <label>Account role<select class="f" name="role" required><option value="school_owner">School Owner</option><option value="admin">Administrator</option></select><span class="er"></span></label>
            <label>Email address<input class="f" name="email" type="email" required autocomplete="username"><span class="er"></span></label>
            ${passwordField('Password', 'password', 'current-password')}
            <div class="auth-inline">
              <label><input type="checkbox" name="remember" ${localStorage.getItem(REMEMBER_SESSION_KEY) === 'false' ? '' : 'checked'}> Remember me on this device</label>
              <button type="button" class="b o" id="owner-forgot-link">Forgot password?</button>
            </div>
            <div class="formactions">
              <button class="b pu" data-auth-submit>Login</button>
              <span class="auth-links">New to SDS? <a href="#/owner-register">Register your school</a></span>
            </div>
            <p class="er auth-message" id="owner-auth-error" role="alert" aria-live="polite"></p>
          </div>
        </form>
      </div>
    </section>
  `;

  const ownerForgotPassword = () => `
    <section class="ph"><div class="w"><h1>Reset Password</h1><p style="opacity:.85;margin-top:8px">Send a secure password reset link to your email.</p></div></section>
    <section class="sec" style="padding-top:32px">
      <div class="w auth">
        <form class="cd" id="owner-forgot-form" novalidate>
          <label>Email address<input class="f" name="email" type="email" required autocomplete="username"><span class="er"></span></label>
          <div class="formactions">
            <button class="b pu" data-auth-submit>Send reset link</button>
            <a class="b o" href="#/owner-login">Back to login</a>
          </div>
          <p class="er" id="owner-auth-error" role="alert"></p>
        </form>
      </div>
    </section>
  `;

  const ownerDashboard = () => {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return '';
    const profile = getStoredSchoolProfile();
    const safeProfile = profile || {};
    const status = safeProfile.verification_status || 'draft';
    const profileProgress = [
      safeProfile.school_name,
      safeProfile.district,
      safeProfile.province,
      safeProfile.school_type,
      safeProfile.phone,
      safeProfile.email,
      Array.isArray(safeProfile.education_levels) ? safeProfile.education_levels.length : 0,
    ].filter(Boolean).length;
    const completion = Math.min(100, Math.round((profileProgress / 7) * 100));
    const inquiries = Array.isArray(safeProfile.inquiries) ? safeProfile.inquiries : getStoredInquiries();
    const pending = inquiries.filter((item) => String(item.status || 'new').toLowerCase() !== 'answered').length;
    const vacancies = Array.isArray(safeProfile.vacancies) ? safeProfile.vacancies : [];
    const vacancyPlaces = vacancies.reduce((total, item) => total + (Number(item.places) || 0), 0);
    const adminReview = userIsAdmin(currentSession) ? '<a class="b o" href="#/owner-admin">Open admin review</a>' : '';

    return renderOwnerShell('School Dashboard', 'Manage your school profile, vacancies, and inquiries.', `
      <div class="row"><h2 style="margin:0;flex:2">Welcome, ${escapeHtml(currentSession.name || currentSession.email)}</h2><span class="bd ${status === 'approved' ? '' : 'w2'}">${getProfileStatusText(status)}</span></div>
      <div class="st">
        <div class="cd"><b>${inquiries.length}</b><span class="m">Total inquiries</span></div>
        <div class="cd"><b>${pending}</b><span class="m">Pending</span></div>
        <div class="cd"><b>${vacancyPlaces}</b><span class="m">Vacancy places</span></div>
        <div class="cd"><b>${completion}%</b><span class="m">Profile progress</span></div>
      </div>
      <div class="cd">
        <b>Profile completion status</b>
        <div class="pb"><i data-w="${completion}" style="width:${completion}%"></i></div>
      </div>
      <div class="owneractions">
        <a class="cd" href="#/owner-profile"><div class="ic">${ic('sch')}</div><h3>Edit school profile</h3><p class="m">Update address, description, fees, and verification details.</p></a>
        <a class="cd" href="#/owner-vacancies"><div class="ic">${ic('ok')}</div><h3>Update vacancies</h3><p class="m">Manage class levels, combinations, and open places.</p></a>
        <a class="cd" href="#/owner-inquiries"><div class="ic">${ic('mail')}</div><h3>Inquiries</h3><p class="m">Read parent and student questions and reply when needed.</p></a>
        <a class="cd" href="#/owner-settings"><div class="ic">${ic('usr')}</div><h3>Account settings</h3><p class="m">Review your owner account and logout securely.</p></a>
      </div>
      <div class="formactions">${adminReview}</div>
    `);
  };

  const ownerProfile = () => {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return '';
    const profile = getStoredSchoolProfile() || {
      school_name: currentSession.schoolName || '',
      description: '',
      province: '',
      district: currentSession.district || '',
      sector: '',
      address: '',
      school_type: currentSession.schoolType || 'Private',
      education_levels: ['Secondary'],
      subject_combinations: ['PCM'],
      boarding_arrangement: 'Mixed',
      tuition_fees: '',
      period_covered: '',
      facilities: [],
      phone: currentSession.phone || '',
      email: currentSession.email || '',
      website: '',
      admission_requirements: '',
      transfer_requirements: '',
      vacancies: [],
      verification_status: 'draft',
    };

    const combinations = ['PCM', 'PCB', 'MCB', 'MEG', 'MCE', 'MPC', 'HGL', 'TVET'];
    const levels = ['Primary', 'Lower Secondary', 'Upper Secondary', 'TVET', 'University'];

    return renderOwnerShell('School Profile', `Manage your school listing and save drafts or submit for approval.`, `
      <form class="cd" id="owner-profile-form">
        <div class="authgrid">
          <label>Official school name<input class="f" name="school_name" required value="${escapeHtml(profile.school_name || '')}"></label>
          <label>School logo URL<input class="f" name="logo_url" value="${escapeHtml(profile.logo_url || '')}" placeholder="https://example.com/logo.png"></label>
          <label>Province<input class="f" name="province" required value="${escapeHtml(profile.province || '')}" placeholder="Kigali City"></label>
          <label>District<input class="f" name="district" required value="${escapeHtml(profile.district || '')}" placeholder="Gasabo"></label>
          <label>Sector<input class="f" name="sector" value="${escapeHtml(profile.sector || '')}"></label>
          <label>Street address<input class="f" name="address" value="${escapeHtml(profile.address || '')}"></label>
          <label>Ownership<select class="f" name="school_type"><option ${profile.school_type === 'Public' ? 'selected' : ''}>Public</option><option ${profile.school_type === 'Private' ? 'selected' : ''}>Private</option></select></label>
          <label>Boarding / day arrangement<select class="f" name="boarding_arrangement"><option ${profile.boarding_arrangement === 'Boarding' ? 'selected' : ''}>Boarding</option><option ${profile.boarding_arrangement === 'Day' ? 'selected' : ''}>Day</option><option ${profile.boarding_arrangement === 'Mixed' ? 'selected' : ''}>Mixed</option></select></label>
          <label>Tuition fees<input class="f" name="tuition_fees" value="${escapeHtml(profile.tuition_fees || '')}" placeholder="RWF 300,000"></label>
          <label>Period covered<input class="f" name="period_covered" value="${escapeHtml(profile.period_covered || '')}" placeholder="Per term / yearly"></label>
          <label>Phone number<input class="f" name="phone" type="tel" value="${escapeHtml(profile.phone || '')}"></label>
          <label>Email<input class="f" name="email" type="email" value="${escapeHtml(profile.email || '')}"></label>
          <label>Official website<input class="f" name="website" type="url" value="${escapeHtml(profile.website || '')}"></label>
        </div>

        <label>School description<textarea class="f" name="description">${escapeHtml(profile.description || '')}</textarea></label>
        <label>Education levels offered<input class="f" name="education_levels" value="${escapeHtml((Array.isArray(profile.education_levels) ? profile.education_levels : levels).join(', '))}"></label>
        <label>Facilities<input class="f" name="facilities" value="${escapeHtml((Array.isArray(profile.facilities) ? profile.facilities : []).join(', '))}" placeholder="Library, Science lab, Sports field"></label>
        <label>Admission requirements<textarea class="f" name="admission_requirements">${escapeHtml(profile.admission_requirements || '')}</textarea></label>
        <label>Transfer requirements<textarea class="f" name="transfer_requirements">${escapeHtml(profile.transfer_requirements || '')}</textarea></label>

        <fieldset>
          <legend>Subject combinations</legend>
          ${combinations.map((value) => `<label style="display:inline-flex;margin:6px 12px 6px 0;align-items:center;gap:8px"><input type="checkbox" name="subject_combinations" value="${value}" ${((profile.subject_combinations || []).includes(value) ? 'checked' : '')}> ${value}</label>`).join('')}
        </fieldset>

        <div class="formactions" style="margin-top:12px">
          <button type="submit" class="b">Save profile</button>
          <button type="submit" class="b o" data-submit-draft="true">Save draft</button>
          <a class="b o" href="#/owner-dashboard">Cancel</a>
        </div>
      </form>
    `);
  };

  const ownerVacancies = () => {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return '';
    const profile = getStoredSchoolProfile() || { vacancies: [{ className: 'S4', combination: 'PCM', places: 4, status: 'Available', lastUpdated: new Date().toISOString() }] };
    const rows = Array.isArray(profile.vacancies) && profile.vacancies.length ? profile.vacancies : [{ className: '', combination: '', places: 0, status: 'Available', lastUpdated: new Date().toISOString() }];

    return renderOwnerShell('Vacancy Management', 'Update class levels, combinations, and open spaces.', `
      <form class="cd" id="owner-vacancy-form">
        <p class="m">Vacancy records are not guaranteed until they are verified by the admin team.</p>
        <div id="vacancy-rows">
          ${rows.map((row, index) => `
            <div class="vacrow">
              <label>Class<input class="f" name="vacancy-class" value="${escapeHtml(row.className || '')}" placeholder="S4"></label>
              <label>Combination<input class="f" name="vacancy-combination" value="${escapeHtml(row.combination || '')}" placeholder="PCM"></label>
              <label>Places<input class="f" name="vacancy-places" type="number" min="0" step="1" value="${Number(row.places) || 0}"></label>
              <label>Status<select class="f" name="vacancy-status"><option ${row.status === 'Available' ? 'selected' : ''}>Available</option><option ${row.status === 'Full' ? 'selected' : ''}>Full</option><option ${row.status === 'Not Confirmed' ? 'selected' : ''}>Not Confirmed</option></select></label>
              <button type="button" class="b o" data-remove-vacancy aria-label="Remove vacancy row">Remove</button>
            </div>
          `).join('')}
        </div>
        <div class="formactions">
          <button type="button" class="b o" id="add-vacancy">Add row</button>
          <button class="b">Save vacancies</button>
        </div>
      </form>
    `);
  };

  const ownerInquiries = () => {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return '';
    const inquiries = Array.isArray(getStoredInquiries()) ? getStoredInquiries() : [];

    return renderOwnerShell('Parent and Student Inquiries', 'Review and respond to questions about vacancies and admissions.', `
      ${inquiries.length ? `
        <div class="ox cd">
          <table class="tb">
            <thead>
              <tr><th>Student</th><th>Subject</th><th>Message</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${inquiries.map((item) => `
                <tr>
                  <td>${escapeHtml(item.name || 'Parent / student')}</td>
                  <td>${escapeHtml(item.subject || 'General')}</td>
                  <td>${escapeHtml(item.message || 'No message')}</td>
                  <td><span class="bd ${item.status === 'answered' ? '' : 'w2'}">${escapeHtml(item.status === 'answered' ? 'Answered' : 'Pending')}</span></td>
                  <td>
                    <select class="f" data-inquiry-status="${escapeHtml(item.id || item.message)}">
                      <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option>
                      <option value="answered" ${item.status === 'answered' ? 'selected' : ''}>Answered</option>
                    </select>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="cd">No student or parent inquiries have been sent to this school yet.</div>'}
    `);
  };

  const ownerSettings = () => {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return '';
    const profile = getStoredSchoolProfile() || {};
    const verificationText = profile.verification_status ? getProfileStatusText(profile.verification_status) : 'Draft';

    return renderOwnerShell('Account Settings', 'Review your secure account details and logout.', `
      <div class="cd">
        <h3>Owner profile</h3>
        <p><b>${escapeHtml(currentSession.name || currentSession.email)}</b></p>
        <p class="m">Email: ${escapeHtml(currentSession.email || 'Not available')}</p>
        <p class="m">Phone: ${escapeHtml(currentSession.phone || 'Not available')}</p>
        <p class="m">School: ${escapeHtml(profile.school_name || currentSession.schoolName || 'Not set')}</p>
        <p class="m">Verification status: ${escapeHtml(verificationText)}</p>
        <p class="m">Authentication: ${supabase ? 'Supabase Auth (when configured)' : 'Local demo mode'}</p>
        <button class="b o" data-owner-logout>Log out</button>
      </div>
    `);
  };

  const ownerAdmin = () => {
    const currentSession = getCurrentOwnerSession();
    if (!currentSession) {
      location.hash = '#/owner-login';
      return '';
    }
    if (!userIsAdmin(currentSession)) {
      return renderOwnerShell('Administrator Access', 'Only an approved school administrator can use this area.', `
        <div class="cd"><p class="m">Your account is not registered as an administrator. Contact the platform owner to request access.</p></div>
      `);
    }

    const rows = getStoredSchoolProfile() ? [getStoredSchoolProfile()] : [];
    const adminItems = rows.length ? rows : [];

    return renderOwnerShell('School Verification', 'Review newly registered schools and approve or reject them.', `
      ${adminItems.length ? `
        <div class="ox cd">
          <table class="tb">
            <thead><tr><th>School</th><th>Owner</th><th>Status</th><th>Decision</th></tr></thead>
            <tbody>
              ${adminItems.map((item) => `
                <tr>
                  <td>${escapeHtml(item.school_name || 'Untitled school')}</td>
                  <td>${escapeHtml(item.owner_email || currentSession.email)}</td>
                  <td><span class="bd ${item.verification_status === 'approved' ? '' : 'w2'}">${escapeHtml(getProfileStatusText(item.verification_status || 'pending_verification'))}</span></td>
                  <td>
                    <div class="formactions">
                      <button type="button" class="b" data-admin-action="approve" data-profile-id="${escapeHtml(item.id || 'draft')}">Approve</button>
                      <button type="button" class="b o" data-admin-action="reject" data-profile-id="${escapeHtml(item.id || 'draft')}">Reject</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="cd">No school registrations are waiting for review.</div>'}
    `);
  };

  function updateLocalProfileRecord(patch) {
    const stored = getStoredSchoolProfile() || {};
    const next = { ...stored, ...patch, updated_at: new Date().toISOString() };
    setStoredSchoolProfile(next);
    const session = getCurrentOwnerSession();
    if (session) {
      session.schoolName = next.school_name || session.schoolName || '';
      session.district = next.district || session.district || '';
      saveCurrentOwnerSession(session);
    }
    return next;
  }

  async function handleOwnerRegisterSubmit(form) {
    const errorNode = document.getElementById('owner-auth-error');
    if (!errorNode) return;
    errorNode.textContent = '';
    if (!validateAuthForm(form, true)) return;

    const email = String(form.elements.email.value || '').trim().toLowerCase();
    const password = String(form.elements.password.value || '');
    const confirm = String(form.elements.confirm.value || '');
    const fullName = String(form.elements.name.value || '').trim();
    const phone = String(form.elements.phone.value || '').trim();
    const schoolName = String(form.elements.schoolName.value || '').trim();
    const district = String(form.elements.district.value || '').trim();
    const schoolType = String(form.elements.schoolType.value || '').trim();
    const position = String(form.elements.position.value || '').trim();

    if (password !== confirm) {
      errorNode.textContent = 'Passwords do not match.';
      return;
    }

    try {
      if (!supabase) {
        throw new Error('Authentication is not configured. Set up Supabase in supabase-config.js before creating an account.');
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            phone,
            school_name: schoolName,
            district,
            school_type: schoolType,
            position,
            terms_accepted_at: new Date().toISOString(),
          },
        },
      });

      if (error) throw error;
      if (!data?.user) {
        throw new Error('Registration did not return an account. Please try again.');
      }

      toast('Account created. Check your email to verify your address before logging in.');
      location.hash = '#/owner-login';
    } catch (error) {
      console.error('Owner registration failed:', error);
      errorNode.textContent = error.message || 'Could not create the owner account.';
    }
  }

  async function handleOwnerLoginSubmit(form) {
    const errorNode = document.getElementById('owner-auth-error');
    if (!errorNode) return;
    errorNode.textContent = '';
    if (!validateAuthForm(form)) return;

    const email = String(form.elements.email.value || '').trim().toLowerCase();
    const password = String(form.elements.password.value || '');
    const requestedRole = String(form.elements.role.value || '');

    try {
      if (!supabase) {
        throw new Error('Authentication is not configured. Set up Supabase in supabase-config.js before logging in.');
      }
      localStorage.setItem(REMEMBER_SESSION_KEY, form.elements.remember.checked ? 'true' : 'false');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data?.user) {
        throw new Error('The system did not return a valid authenticated user.');
      }

      const authenticated = await refreshSupabaseSession();
      if (!authenticated) {
        throw new Error('Unable to verify your account permissions. Please try again.');
      }
      if (authenticated.role !== requestedRole) {
        await supabase.auth.signOut();
        verifiedSession = null;
        throw new Error('This account does not match the selected portal role.');
      }
      if (authenticated.role === 'admin') {
        toast('Signed in successfully.');
        location.hash = '#/owner-admin';
      } else if (authenticated.role === 'school_owner') {
        toast('Signed in successfully.');
        location.hash = '#/owner-dashboard';
      } else {
        await supabase.auth.signOut();
        verifiedSession = null;
        throw new Error('This account does not have access to the School Owner Portal.');
      }
    } catch (error) {
      console.error('Owner login failed:', error);
      errorNode.textContent = error.message || 'Login failed. Please try again.';
    }
  }

  async function handleOwnerForgotSubmit(form) {
    const errorNode = document.getElementById('owner-auth-error');
    if (!errorNode) return;
    errorNode.textContent = '';
    const email = String(form.elements.email.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errorNode.textContent = 'Enter a valid email address.';
      return;
    }

    try {
      if (supabase) {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${location.origin}${location.pathname}#/owner-login`,
        });
        if (error) throw error;
        toast('Password reset instructions were sent to your email.');
        location.hash = '#/owner-login';
        return;
      }
      throw new Error('Password recovery is not configured. Set up Supabase in supabase-config.js first.');
    } catch (error) {
      console.error('Password reset failed:', error);
      errorNode.textContent = error.message || 'Password reset request failed.';
    }
  }

  function handleOwnerProfileSubmit(form, draftOnly) {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return;
    const profile = getStoredSchoolProfile() || {};
    const formData = new FormData(form);
    const payload = {
      id: profile.id || `profile-${Date.now()}`,
      owner_id: currentSession.id || currentSession.email,
      owner_email: currentSession.email,
      school_name: String(formData.get('school_name') || '').trim(),
      logo_url: String(formData.get('logo_url') || '').trim(),
      description: String(formData.get('description') || '').trim(),
      province: String(formData.get('province') || '').trim(),
      district: String(formData.get('district') || '').trim(),
      sector: String(formData.get('sector') || '').trim(),
      address: String(formData.get('address') || '').trim(),
      school_type: String(formData.get('school_type') || 'Private').trim(),
      education_levels: String(formData.get('education_levels') || '').split(',').map((value) => value.trim()).filter(Boolean),
      subject_combinations: formData.getAll('subject_combinations').map(String),
      boarding_arrangement: String(formData.get('boarding_arrangement') || 'Mixed').trim(),
      tuition_fees: String(formData.get('tuition_fees') || '').trim(),
      period_covered: String(formData.get('period_covered') || '').trim(),
      facilities: String(formData.get('facilities') || '').split(',').map((value) => value.trim()).filter(Boolean),
      phone: String(formData.get('phone') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      website: String(formData.get('website') || '').trim(),
      admission_requirements: String(formData.get('admission_requirements') || '').trim(),
      transfer_requirements: String(formData.get('transfer_requirements') || '').trim(),
      verification_status: draftOnly ? 'draft' : 'pending_verification',
      vacancies: Array.isArray(profile.vacancies) ? profile.vacancies : [],
      inquiries: Array.isArray(profile.inquiries) ? profile.inquiries : [],
      updated_at: new Date().toISOString(),
    };

    if (!payload.school_name || !payload.district || !payload.province) {
      toast('School name, district, and province are required.');
      return;
    }
    if (payload.email && !/^\S+@\S+\.\S+$/.test(payload.email)) {
      toast('Enter a valid school email address.');
      return;
    }

    setStoredSchoolProfile(payload);
    saveCurrentOwnerSession({ ...currentSession, schoolName: payload.school_name, district: payload.district, phone: payload.phone || currentSession.phone || '' });
    toast(draftOnly ? 'Draft saved successfully.' : 'School profile saved and submitted for verification.');
    location.hash = '#/owner-dashboard';
  }

  function handleOwnerVacancySubmit(form) {
    const currentSession = ownerRouteGuard();
    if (!currentSession) return;
    const rows = Array.from(form.querySelectorAll('.vacrow'));
    const vacancies = [];
    for (const row of rows) {
      const className = String(row.querySelector('[name="vacancy-class"]').value || '').trim();
      const combination = String(row.querySelector('[name="vacancy-combination"]').value || '').trim();
      const placesValue = Number(row.querySelector('[name="vacancy-places"]').value || 0);
      const status = String(row.querySelector('[name="vacancy-status"]').value || 'Available');
      if (!className && !combination && !placesValue) continue;
      if (!className || !combination || !Number.isInteger(placesValue) || placesValue < 0) {
        toast('Complete each vacancy row with a class, subject combination, and whole-number places.');
        return;
      }
      vacancies.push({ className, combination, places: placesValue, status, lastUpdated: new Date().toISOString() });
    }

    const profile = getStoredSchoolProfile() || {};
    const next = { ...profile, vacancies, updated_at: new Date().toISOString() };
    setStoredSchoolProfile(next);
    toast('Vacancy information was updated successfully.');
    location.hash = '#/owner-dashboard';
  }

  function handleInquiryStatusChange(target) {
    const status = String(target.value || 'pending');
    const profile = getStoredSchoolProfile() || {};
    const inquiries = Array.isArray(profile.inquiries) ? profile.inquiries : getStoredInquiries();
    const inquiryId = target.getAttribute('data-inquiry-status');
    const next = inquiries.map((item) => {
      if ((item.id || item.message) === inquiryId) {
        return { ...item, status: status === 'answered' ? 'answered' : 'pending' };
      }
      return item;
    });
    setStoredInquiries(next);
    if (profile) {
      profile.inquiries = next;
      setStoredSchoolProfile(profile);
    }
    toast('Inquiry status updated.');
  }

  function handleAdminAction(target) {
    const action = target.getAttribute('data-admin-action');
    const profileId = target.getAttribute('data-profile-id');
    const profile = getStoredSchoolProfile() || {};
    if (profileId && profile.id === profileId) {
      profile.verification_status = action === 'approve' ? 'approved' : 'rejected';
      setStoredSchoolProfile(profile);
      toast(action === 'approve' ? 'School profile approved.' : 'School profile rejected.');
      location.hash = '#/owner-dashboard';
    }
  }

  function registerPortalRoutes() {
    if (typeof R !== 'undefined') {
      R['owner-register'] = ownerRegister;
      R['owner-login'] = ownerLogin;
      R['owner-dashboard'] = ownerDashboard;
      R['owner-profile'] = ownerProfile;
      R['owner-vacancies'] = ownerVacancies;
      R['owner-inquiries'] = ownerInquiries;
      R['owner-settings'] = ownerSettings;
      R['owner-admin'] = ownerAdmin;
      R['owner-forgot-password'] = ownerForgotPassword;
      R.dashboard = ownerDashboard;
    }
  }

  registerPortalRoutes();
  if (typeof window.go === 'function') {
    window.go();
  }
  if (supabase) {
    refreshSupabaseSession().then((session) => {
      if (!session) return;
      const currentRoute = location.hash.slice(2).split('/')[0];
      if (currentRoute === 'owner-login' || currentRoute === 'dashboard' || currentRoute === 'owner-dashboard' || currentRoute === 'owner-admin') {
        location.hash = session.role === 'admin' ? '#/owner-admin' : '#/owner-dashboard';
      }
    }).catch((error) => {
      console.error('Could not restore the authenticated session:', error);
      if (location.hash.slice(2).split('/')[0].startsWith('owner-') || location.hash === '#/dashboard') {
        location.hash = '#/owner-login';
      }
    });
  }

  async function submitWithLoading(form, operation, label) {
    const button = form.querySelector('[data-auth-submit]');
    if (!button) return operation();
    const originalText = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('auth-loading');
    button.textContent = label;
    try {
      await operation();
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.remove('auth-loading');
      button.textContent = originalText;
    }
  }

  document.addEventListener('click', (event) => {
    const passwordToggle = event.target.closest('[data-show-password]');
    if (passwordToggle) {
      const input = passwordToggle.previousElementSibling;
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        passwordToggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
        passwordToggle.setAttribute('aria-label', `${input.type === 'password' ? 'Show' : 'Hide'} ${passwordToggle.dataset.showPassword}`);
        passwordToggle.setAttribute('aria-pressed', input.type === 'text' ? 'true' : 'false');
      }
      return;
    }

    const forgotButton = event.target.closest('#owner-forgot-link');
    if (forgotButton) {
      location.hash = '#/owner-forgot-password';
      return;
    }

    const adminAction = event.target.closest('[data-admin-action]');
    if (adminAction) {
      handleAdminAction(adminAction);
      return;
    }

    const removeButton = event.target.closest('[data-remove-vacancy]');
    if (removeButton) {
      const rows = removeButton.closest('#vacancy-rows');
      const remaining = rows.querySelectorAll('.vacrow');
      if (remaining.length > 1) {
        removeButton.closest('.vacrow').remove();
      } else {
        const fields = removeButton.closest('.vacrow').querySelectorAll('input,select');
        fields.forEach((field) => {
          if (field.tagName === 'INPUT') field.value = '';
        });
      }
    }

    if (event.target.closest('[data-owner-logout]')) {
      event.preventDefault();
      clearCurrentOwnerSession();
      verifiedSession = null;
      if (supabase) {
        supabase.auth.signOut().catch((error) => console.error('Could not end the Supabase session:', error));
      }
      location.hash = '#/owner-login';
      toast('You were logged out from the school owner portal.');
    }
  });

  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form || !form.id) return;
    if (form.id === 'owner-register-form') {
      await submitWithLoading(form, () => handleOwnerRegisterSubmit(form), 'Creating account…');
      return;
    }
    if (form.id === 'owner-login-form') {
      await submitWithLoading(form, () => handleOwnerLoginSubmit(form), 'Signing in…');
      return;
    }
    if (form.id === 'owner-forgot-form') {
      await submitWithLoading(form, () => handleOwnerForgotSubmit(form), 'Sending link…');
      return;
    }
    if (form.id === 'owner-profile-form') {
      handleOwnerProfileSubmit(form, form.querySelector('[data-submit-draft="true"]') && event.submitter && event.submitter.dataset.submitDraft === 'true');
      return;
    }
    if (form.id === 'owner-vacancy-form') {
      handleOwnerVacancySubmit(form);
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.matches('[data-inquiry-status]')) return;
    handleInquiryStatusChange(target);
  });

  window.SDS_OWNER_PORTAL = {
    getCurrentOwnerSession,
    saveCurrentOwnerSession,
    clearCurrentOwnerSession,
    getStoredSchoolProfile,
    setStoredSchoolProfile,
    getStoredInquiries,
    setStoredInquiries,
    supabase,
    userIsAdmin,
    portalConfig,
  };
})();
