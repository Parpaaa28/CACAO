async function getMe(){
  try{
    const r = await fetch("/api/auth/me");
    const j = await r.json();
    return j.user || null;
  }catch(e){
    return null;
  }
}

function formatPHP(n){
  return "PHP " + Number(n || 0).toFixed(2);
}

async function updateNav(){
  const user = await getMe();

  const elUser = document.getElementById("nav-user");
  const elProfile = document.getElementById("nav-profile");
  const elLogout = document.getElementById("nav-logout");
  const elAdmin = document.getElementById("nav-admin");

  if(elUser) elUser.textContent = user ? ("Hi, " + user.name) : "Not logged in";
  if(elProfile){
    elProfile.href = user ? "/profile.html" : "/login.html";
    if(!elProfile.classList.contains("icon-only")){
      elProfile.textContent = "Profile";
    }
  }
  if(elLogout) elLogout.style.display = user ? "inline-block" : "none";
  if(elAdmin) elAdmin.style.display = user && user.is_admin ? "inline-block" : "none";

  if(elLogout){
    elLogout.onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      location.href = "/";
    };
  }

  await updateCartBadge();
  await updateWishlistBadge();
}

async function updateCartBadge(){
  const badge = document.getElementById("nav-cart-count");
  if(!badge) return;

  try{
    const r = await fetch("/api/cart");
    if(!r.ok){ badge.textContent = "0"; return; }
    const j = await r.json();
    const count = (j.data || []).reduce((s, it) => s + Number(it.qty || 0), 0);
    badge.textContent = String(count);
  }catch(e){
    badge.textContent = "0";
  }
}

async function updateWishlistBadge(){
  const badge = document.getElementById("nav-wishlist-count");
  if(!badge) return;
  try{
    const r = await fetch("/api/wishlist");
    if(!r.ok){ badge.textContent = "0"; return; }
    const j = await r.json();
    badge.textContent = String((j.data || []).length);
  }catch(e){
    badge.textContent = "0";
  }
}

async function requireLogin(redirect){
  const user = await getMe();
  if(!user){
    if(redirect !== false){
      alert("Please login first.");
      location.href = "/login.html";
    }
    return null;
  }
  return user;
}

window.addEventListener("DOMContentLoaded", () => {
  updateNav();
});
